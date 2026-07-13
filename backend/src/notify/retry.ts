import { and, eq, lte } from "drizzle-orm";
import { promises as fs } from "fs";
import { join } from "path";
import { db } from "../db";
import { notificationDeliveries } from "../db/schema";
import { env } from "../env";
import { renderAlert } from "./render";
import { sendChannel } from "./drivers";
import { snapshotUrl } from "./snapshot-url";

const BACKOFF = [30_000, 120_000, 600_000, 3_600_000, 6 * 3_600_000];
export function nextDelayMs(attempts: number): number { return BACKOFF[Math.min(attempts, BACKOFF.length) - 1]; }

export async function enqueueFailure(channelId: string, alertId: string | null, inputs: any, errMsg: string, nowMs: number): Promise<void> {
  // attempts: 1 records the inline send that already failed. The queued
  // retry itself is due immediately (next sweep tick) — exponential backoff
  // only kicks in once a *retry* also fails (see sweepOnce's catch below).
  await db.insert(notificationDeliveries).values({
    channelId, alertId, payload: inputs, attempts: 1,
    nextAttemptAt: new Date(nowMs), status: "pending", lastError: errMsg,
  }).catch((e) => console.error("[notify] enqueue failed:", (e as Error).message));
}

type Sender = (inputs: any) => Promise<{ ok: boolean; status: number }>;

async function realSend(inputs: any): Promise<{ ok: boolean; status: number }> {
  let snap: { bytes: Uint8Array; url: string } | null = null;
  if (inputs.alert?.snapshot_path) {
    try { snap = { bytes: new Uint8Array(await fs.readFile(join(env.RECORDINGS_DIR, inputs.alert.snapshot_path))), url: snapshotUrl(inputs.alert.id, Date.now()) }; } catch {}
  }
  const payload = renderAlert(inputs.type, inputs.alert, inputs.cameraName, inputs.ruleName, inputs.link, snap?.url ?? null);
  return sendChannel(inputs.type, inputs.config, payload, snap);
}

export async function sweepOnce(nowMs: number, sender: Sender = realSend): Promise<void> {
  const due = await db.select().from(notificationDeliveries)
    .where(and(eq(notificationDeliveries.status, "pending"), lte(notificationDeliveries.nextAttemptAt, new Date(nowMs))))
    .limit(20);
  for (const row of due) {
    // claim: guarded update so a concurrent tick can't double-send
    const claimed = await db.update(notificationDeliveries).set({ status: "sending" })
      .where(and(eq(notificationDeliveries.id, row.id), eq(notificationDeliveries.status, "pending"))).returning();
    if (claimed.length === 0) continue;
    try {
      const res = await sender(row.payload);
      if (!res.ok) throw new Error(`status ${res.status}`);
      await db.update(notificationDeliveries).set({ status: "sent" }).where(eq(notificationDeliveries.id, row.id));
    } catch (e) {
      const attempts = row.attempts + 1;
      const dead = attempts >= 5;
      await db.update(notificationDeliveries).set({
        status: dead ? "dead" : "pending", attempts,
        nextAttemptAt: new Date(nowMs + nextDelayMs(attempts)), lastError: (e as Error).message,
      }).where(eq(notificationDeliveries.id, row.id));
    }
  }
}

export function startNotifyRetry(): void {
  setInterval(() => { void sweepOnce(Date.now()); }, 15_000);
  console.log("[notify] retry sweeper started");
}
