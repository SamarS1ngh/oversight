import { eq } from "drizzle-orm";
import { redisSub } from "./redis";
import { CHANNELS } from "./channels";
import { db } from "../db";
import { alerts, cameras, clips } from "../db/schema";
import { ownerOf, sendToUser } from "./connections";
import { handleAnswer } from "./signaling";
import { dispatchNotifications, dispatchCameraEvent } from "../notify/dispatch";
import { safeSnapshotPath } from "../notify/snapshot-url";

// Channels still delivered over pub/sub. detections + clips moved to the
// durable stream consumer (see stream-consumer.ts) and are intentionally absent.
export const PUBSUB_CHANNELS = [
  CHANNELS.stats,
  CHANNELS.webrtcAnswers,
  CHANNELS.discoveryResults,
];

// Subscribes to everything the worker emits and (a) persists alerts, (b) keeps
// camera.status in sync, (c) fans events out to the owning user's WebSockets,
// (d) routes WebRTC answers back to the signaling relay.
export function startIngest() {
  redisSub.subscribe(...PUBSUB_CHANNELS, (err) => {
    if (err) console.error("[ingest] subscribe failed:", err.message);
  });

  redisSub.on("message", (channel, raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (channel === CHANNELS.stats) void onStats(msg);
    else if (channel === CHANNELS.webrtcAnswers) handleAnswer(msg);
    else if (channel === CHANNELS.discoveryResults) onDiscoveryResults(msg);
  });

  console.log("[ingest] subscribed to stats, webrtc:answers, discovery:results");
}

export async function onDetection(d: any) {
  if (!d?.id || !d?.camera_id) return;
  try {
    // id is the worker's UUID -> idempotent on redelivery
    await db
      .insert(alerts)
      .values({
        id: d.id,
        cameraId: d.camera_id,
        type: d.type ?? "person_detected",
        ts: new Date(d.ts),
        confidence: d.confidence,
        count: d.count,
        bboxes: d.bboxes ?? null,
        frameW: d.frame_w ?? null,
        frameH: d.frame_h ?? null,
        workerId: d.worker_id ?? null,
        label: d.label ?? null,
        ruleId: d.rule_id ?? null,
        severity: d.severity ?? "low",
        snapshotPath: safeSnapshotPath(d.snapshot_path),
      })
      .onConflictDoNothing();
  } catch (e) {
    // Rethrow so the durable stream consumer leaves the entry PENDING and
    // retries it — a transient DB failure must not silently drop a detection
    // (onConflictDoNothing means a duplicate id does NOT reach here, so this is
    // a genuine write failure, not a redelivery).
    console.error("[ingest] alert insert failed:", (e as Error).message);
    throw e;
  }
  const owner = await ownerOf(d.camera_id);
  if (owner) sendToUser(owner, { channel: "alert", data: d });
  if (owner) void dispatchNotifications(d, owner);
}

// Applies a camera_state (or camera_stats heartbeat) event to the `cameras`
// row: updates status + lastSeenAt, and on a transition into offline (prior
// status wasn't already offline) or a recovery into live (prior was
// offline), dispatches a camera lifecycle notification if the camera opted
// in via notifyOnOffline. Exported so it can be unit-tested directly rather
// than only via the Redis-fed onStats path.
export async function applyCameraState(s: any): Promise<void> {
  if (s.type === "camera_state" && s.state) {
    const [cam] = await db.select().from(cameras).where(eq(cameras.id, s.camera_id)).limit(1);
    const prev = cam?.status;
    await db
      .update(cameras)
      .set({ status: s.state, updatedAt: new Date() })
      .where(eq(cameras.id, s.camera_id))
      .catch(() => {});
    if (cam && cam.notifyOnOffline) {
      const enteringOffline = s.state === "offline" && prev !== "offline";
      const recovered = s.state === "live" && prev === "offline";
      if (enteringOffline || recovered) {
        void dispatchCameraEvent({ id: cam.id, name: cam.name }, cam.userId, enteringOffline ? "offline" : "online");
      }
    }
  } else if (s.type === "camera_stats") {
    // heartbeat: stamp lastSeenAt from the worker's last_frame_at, which
    // freezes when frames stop (unlike wall-clock time, which would keep
    // advancing every ~1s even while the camera is reconnecting/offline).
    if (s.last_frame_at) {
      await db.update(cameras).set({ lastSeenAt: new Date(s.last_frame_at) }).where(eq(cameras.id, s.camera_id)).catch(() => {});
    }
  }
}

async function onStats(s: any) {
  if (!s?.camera_id) return;
  await applyCameraState(s).catch(() => {});
  const owner = await ownerOf(s.camera_id);
  if (owner) {
    const channel = s.type === "camera_state" ? "state" : "stats";
    sendToUser(owner, { channel, data: s });
  }
}

export async function onClip(k: any) {
  if (!k?.id || !k?.camera_id || !k?.path) return;
  const base = {
    id: k.id,
    cameraId: k.camera_id,
    backend: k.backend ?? "local",
    path: k.path,
    thumbPath: k.thumb_path ?? null,
    startTs: new Date(k.start_ts),
    endTs: new Date(k.end_ts),
    durationMs: k.duration_ms ?? 0,
    sizeBytes: k.size_bytes ?? 0,
  };
  try {
    await db.insert(clips).values({ ...base, alertId: k.alert_id ?? null }).onConflictDoNothing();
  } catch {
    // The alert row may not have landed yet (FK). Store the clip unlinked
    // rather than lose it.
    try {
      await db.insert(clips).values({ ...base, alertId: null }).onConflictDoNothing();
    } catch (e) {
      // Both inserts failed for a non-FK reason (a genuine DB error) — rethrow
      // so the stream consumer retries rather than dropping the clip row.
      console.error("[ingest] clip insert failed:", (e as Error).message);
      throw e;
    }
  }
  const owner = await ownerOf(k.camera_id);
  if (owner) sendToUser(owner, { channel: "clip", data: k });
}

export function onDiscoveryResults(msg: any, send = sendToUser): void {
  if (msg?.user_id) send(msg.user_id, { channel: "discovery", data: msg });
}
