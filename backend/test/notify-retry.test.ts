import { test, expect, beforeAll } from "bun:test";
import { sql, eq } from "drizzle-orm";
import { nextDelayMs, enqueueFailure, sweepOnce } from "../src/notify/retry";
import { db } from "../src/db";
import { notificationChannels, notificationDeliveries } from "../src/db/schema";

test("backoff grows then caps at the last step", () => {
  expect(nextDelayMs(1)).toBe(30_000);
  expect(nextDelayMs(2)).toBe(120_000);
  expect(nextDelayMs(5)).toBe(6 * 3600_000);
  expect(nextDelayMs(99)).toBe(6 * 3600_000);
});

let dbUp = false;
beforeAll(async () => { try { await db.execute(sql`select 1`); dbUp = true; } catch { dbUp = false; } });

async function seedChannel() {
  const [u] = await db.execute(sql`insert into users (username, password_hash) values (${"r_" + Math.random().toString(36).slice(2)}, 'x') returning id`) as any;
  const [ch] = await db.insert(notificationChannels).values({ userId: (u as any).id, type: "webhook", name: "r", config: { url: "http://127.0.0.1:1/x" } }).returning();
  return ch;
}

test("a due pending row re-sends; success marks sent", async () => {
  if (!dbUp) return;
  const ch = await seedChannel();
  await enqueueFailure(ch.id, null, { type: "webhook", config: ch.config, alert: { id: "a", camera_id: "c", ts: new Date().toISOString(), count: 1, confidence: 1, severity: "low" }, cameraName: "c", ruleName: null, link: "http://l" }, "boom", 0);
  const [row] = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.channelId, ch.id));
  expect(row.status).toBe("pending");
  await sweepOnce(1000, async () => ({ ok: true, status: 200 }));
  const [after] = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.channelId, ch.id));
  expect(after.status).toBe("sent");
});

test("a failing send bumps attempts + backoff, dead at 5", async () => {
  if (!dbUp) return;
  const ch = await seedChannel();
  await enqueueFailure(ch.id, null, { type: "webhook", config: ch.config, alert: { id: "a2", camera_id: "c", ts: new Date().toISOString(), count: 1, confidence: 1, severity: "low" }, cameraName: "c", ruleName: null, link: "http://l" }, "boom", 0);
  let now = 0;
  for (let i = 0; i < 5; i++) { now += 7 * 3600_000; await sweepOnce(now, async () => { throw new Error("still down"); }); }
  const [dead] = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.channelId, ch.id));
  expect(dead.status).toBe("dead");
  expect(dead.attempts).toBeGreaterThanOrEqual(5);
});

test("terminal rows past the retention window are pruned; recent ones survive", async () => {
  if (!dbUp) return;
  const ch = await seedChannel();
  const payload = { type: "webhook", config: ch.config, alert: { id: "a4", camera_id: "c", ts: new Date().toISOString(), count: 1, confidence: 1, severity: "low" }, cameraName: "c", ruleName: null, link: "http://l" };
  const [old] = await db.insert(notificationDeliveries).values({
    channelId: ch.id, alertId: null, payload, attempts: 1,
    nextAttemptAt: new Date(0), status: "sent", createdAt: new Date(0),
  }).returning();
  const [recent] = await db.insert(notificationDeliveries).values({
    channelId: ch.id, alertId: null, payload, attempts: 1,
    nextAttemptAt: new Date(0), status: "sent", createdAt: new Date(),
  }).returning();
  await sweepOnce(Date.now(), async () => ({ ok: true, status: 200 }));
  const [afterOld] = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, old.id));
  const [afterRecent] = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, recent.id));
  expect(afterOld).toBeUndefined();
  expect(afterRecent).toBeDefined();
});

test("a stuck 'sending' row past its lease is reclaimed and re-sent", async () => {
  if (!dbUp) return;
  const ch = await seedChannel();
  // simulate a crash after claim (status='sending') but before the terminal
  // update — a lease that already expired in the past.
  await db.insert(notificationDeliveries).values({
    channelId: ch.id, alertId: null,
    payload: { type: "webhook", config: ch.config, alert: { id: "a3", camera_id: "c", ts: new Date().toISOString(), count: 1, confidence: 1, severity: "low" }, cameraName: "c", ruleName: null, link: "http://l" },
    attempts: 1, nextAttemptAt: new Date(0), status: "sending",
  });
  const [row] = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.channelId, ch.id));
  expect(row.status).toBe("sending");
  await sweepOnce(Date.now(), async () => ({ ok: true, status: 200 }));
  const [after] = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.channelId, ch.id));
  expect(after.status).toBe("sent");
});
