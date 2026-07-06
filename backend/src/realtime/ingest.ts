import { eq } from "drizzle-orm";
import { redisSub } from "./redis";
import { CHANNELS } from "./channels";
import { db } from "../db";
import { alerts, cameras, clips } from "../db/schema";
import { ownerOf, sendToUser } from "./connections";
import { handleAnswer } from "./signaling";

// Subscribes to everything the worker emits and (a) persists alerts, (b) keeps
// camera.status in sync, (c) fans events out to the owning user's WebSockets,
// (d) routes WebRTC answers back to the signaling relay.
export function startIngest() {
  redisSub.subscribe(
    CHANNELS.detections,
    CHANNELS.stats,
    CHANNELS.webrtcAnswers,
    CHANNELS.clips,
    (err) => {
      if (err) console.error("[ingest] subscribe failed:", err.message);
    },
  );

  redisSub.on("message", (channel, raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (channel === CHANNELS.detections) void onDetection(msg);
    else if (channel === CHANNELS.stats) void onStats(msg);
    else if (channel === CHANNELS.webrtcAnswers) handleAnswer(msg);
    else if (channel === CHANNELS.clips) void onClip(msg);
  });

  console.log("[ingest] subscribed to detections, stats, webrtc:answers, clips");
}

async function onDetection(d: any) {
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
      })
      .onConflictDoNothing();
  } catch (e) {
    console.error("[ingest] alert insert failed:", (e as Error).message);
    return;
  }
  const owner = await ownerOf(d.camera_id);
  if (owner) sendToUser(owner, { channel: "alert", data: d });
}

async function onStats(s: any) {
  if (!s?.camera_id) return;
  if (s.type === "camera_state" && s.state) {
    await db
      .update(cameras)
      .set({ status: s.state, updatedAt: new Date() })
      .where(eq(cameras.id, s.camera_id))
      .catch(() => {});
  }
  const owner = await ownerOf(s.camera_id);
  if (owner) {
    const channel = s.type === "camera_state" ? "state" : "stats";
    sendToUser(owner, { channel, data: s });
  }
}

async function onClip(k: any) {
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
      console.error("[ingest] clip insert failed:", (e as Error).message);
      return;
    }
  }
  const owner = await ownerOf(k.camera_id);
  if (owner) sendToUser(owner, { channel: "clip", data: k });
}
