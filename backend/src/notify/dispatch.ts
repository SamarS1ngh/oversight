import { and, eq } from "drizzle-orm";
import { promises as fs } from "fs";
import { join } from "path";
import { db } from "../db";
import { notificationChannels, cameras, rules } from "../db/schema";
import { env } from "../env";
import { shouldNotify } from "./filter";
import { allow } from "./cooldown";
import { renderAlert } from "./render";
import { sendChannel } from "./drivers";
import { snapshotUrl } from "./snapshot-url";
import { enqueueFailure } from "./retry";

// Fire-and-forget: dispatch one persisted alert (the detection event `d`, snake_case)
// to the owner's enabled channels. Never throws to the caller.
export async function dispatchNotifications(alert: any, ownerId: string): Promise<void> {
  try {
    const channels = await db.select().from(notificationChannels)
      .where(and(eq(notificationChannels.userId, ownerId), eq(notificationChannels.enabled, true)));
    if (channels.length === 0) return;

    const [cam] = await db.select({ name: cameras.name }).from(cameras).where(eq(cameras.id, alert.camera_id)).limit(1);
    const cameraName = cam?.name ?? "camera";
    let ruleName: string | null = null;
    if (alert.rule_id) {
      const [r] = await db.select({ name: rules.name }).from(rules).where(eq(rules.id, alert.rule_id)).limit(1);
      ruleName = r?.name ?? null;
    }
    const link = `${env.APP_URL}/events?camera=${alert.camera_id}`;
    const now = Date.now();

    // Read the snapshot bytes once (shared across all channels this alert
    // goes to) rather than per-channel. A missing/unreadable file must not
    // abort dispatch — it just means channels render without a snapshot.
    let snap: { bytes: Uint8Array; url: string } | null = null;
    if (alert.snapshot_path) {
      try {
        const bytes = new Uint8Array(await fs.readFile(join(env.RECORDINGS_DIR, alert.snapshot_path)));
        snap = { bytes, url: snapshotUrl(alert.id, now) };
      } catch {
        snap = null;
      }
    }

    for (const ch of channels) {
      try {
        if (!shouldNotify(ch, alert)) continue;
        if (!allow(`${ch.id}:${alert.camera_id}`, now, ch.cooldownSecs)) continue;
        const payload = renderAlert(ch.type, alert, cameraName, ruleName, link, snap?.url ?? null);
        await sendChannel(ch.type, ch.config, payload, snap);
      } catch (e: any) {
        if (e?.gone) {
          await db.delete(notificationChannels).where(eq(notificationChannels.id, ch.id)).catch(() => {});
          continue;
        }
        console.error(`[notify] channel ${ch.id} (${ch.type}) failed:`, (e as Error).message);
        await enqueueFailure(ch.id, alert.id ?? null, { type: ch.type, config: ch.config, alert, cameraName, ruleName, link }, (e as Error).message, now).catch(() => {});
      }
    }
  } catch (e) {
    console.error("[notify] dispatch failed:", (e as Error).message);
  }
}

// A camera lifecycle event (offline / back online) — reuses the notify
// pipeline but is transient: no alert row, no snapshot, no retry enqueue.
export async function dispatchCameraEvent(
  camera: { id: string; name: string },
  ownerId: string,
  kind: "offline" | "online",
): Promise<void> {
  try {
    const channels = await db.select().from(notificationChannels)
      .where(and(eq(notificationChannels.userId, ownerId), eq(notificationChannels.enabled, true)));
    if (channels.length === 0) return;
    const label = kind === "offline" ? "camera offline" : "camera back online";
    const event: any = {
      id: crypto.randomUUID(), camera_id: camera.id, severity: "high",
      label, rule_id: null, ts: new Date().toISOString(), count: 0, confidence: 0,
    };
    const link = `${env.APP_URL}/dashboard`;
    const now = Date.now();
    for (const ch of channels) {
      try {
        if (!shouldNotify(ch, event)) continue;
        if (!allow(`${ch.id}:${camera.id}:camera`, now, ch.cooldownSecs)) continue;
        const payload = renderAlert(ch.type, event, camera.name, label, link, null);
        await sendChannel(ch.type, ch.config, payload, null);
      } catch (e) {
        console.error(`[notify] camera-event channel ${ch.id} (${ch.type}) failed:`, (e as Error).message);
      }
    }
  } catch (e) {
    console.error("[notify] camera-event dispatch failed:", (e as Error).message);
  }
}
