import { and, eq, inArray, lte } from "drizzle-orm";
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
// how long a claimed ('sending') row is protected from being reclaimed by another
// tick. If the process crashes mid-send, the row self-heals — it becomes due again
// once this lease lapses, instead of being stuck at 'sending' forever.
const CLAIM_LEASE_MS = 120_000;

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

// bump attempts + apply backoff (or mark dead at attempts>=5) after a genuine send
// failure. Shared by the sender-threw and sender-returned-!ok paths below.
async function scheduleRetry(rowId: string, attempts: number, nowMs: number, errMsg: string): Promise<void> {
  const dead = attempts >= 5;
  await db.update(notificationDeliveries).set({
    status: dead ? "dead" : "pending", attempts,
    nextAttemptAt: new Date(nowMs + nextDelayMs(attempts)), lastError: errMsg,
  }).where(eq(notificationDeliveries.id, rowId));
}

export async function sweepOnce(nowMs: number, sender: Sender = realSend): Promise<void> {
  // due = pending rows ready to send, PLUS 'sending' rows whose claim lease has
  // lapsed (crashed mid-send) — both are eligible for (re)claim.
  const due = await db.select().from(notificationDeliveries)
    .where(and(inArray(notificationDeliveries.status, ["pending", "sending"]), lte(notificationDeliveries.nextAttemptAt, new Date(nowMs))))
    .limit(20);
  for (const row of due) {
    // claim: optimistic update guarded on the OBSERVED status + nextAttemptAt, so
    // two concurrent ticks are mutually exclusive, and moving nextAttemptAt forward
    // by the lease means a crashed sender's row is only reclaimable once the lease
    // expires.
    const claimed = await db.update(notificationDeliveries)
      .set({ status: "sending", nextAttemptAt: new Date(nowMs + CLAIM_LEASE_MS) })
      .where(and(
        eq(notificationDeliveries.id, row.id),
        eq(notificationDeliveries.status, row.status),
        eq(notificationDeliveries.nextAttemptAt, row.nextAttemptAt),
      )).returning();
    if (claimed.length === 0) continue; // another tick claimed it first

    let res;
    try {
      res = await sender(row.payload);
    } catch (e) {
      // real send failure → backoff / dead
      await scheduleRetry(row.id, row.attempts + 1, nowMs, (e as Error).message);
      continue;
    }
    if (!res.ok) {
      await scheduleRetry(row.id, row.attempts + 1, nowMs, `status ${res.status}`);
      continue;
    }
    // delivered: mark sent. If THIS write fails, the row stays 'sending' with its
    // lease and gets reclaimed + redelivered later (at-least-once) — NOT counted
    // as a send failure.
    await db.update(notificationDeliveries).set({ status: "sent" }).where(eq(notificationDeliveries.id, row.id)).catch(() => {});
  }
}

export function startNotifyRetry(): void {
  setInterval(() => { void sweepOnce(Date.now()); }, 15_000);
  console.log("[notify] retry sweeper started");
}
