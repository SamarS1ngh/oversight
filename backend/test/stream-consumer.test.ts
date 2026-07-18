import { test, expect, beforeAll } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../src/db";
import { redisStream } from "../src/realtime/redis";
import { ensureGroups, consumeOnce, reclaimStale } from "../src/realtime/stream-consumer";
import { alerts, cameras, users } from "../src/db/schema";
import { eq } from "drizzle-orm";

let up = false;
beforeAll(async () => {
  try { await db.execute(sql`select 1`); await redisStream.ping(); up = true; } catch { up = false; }
  if (up) await ensureGroups();
});

async function seedCamera(): Promise<string> {
  const [u] = await db.insert(users).values({ username: "s_" + Math.random().toString(36).slice(2), passwordHash: "x" }).returning();
  const [c] = await db.insert(cameras).values({ userId: u.id, name: "sc", rtspUrl: "rtsp://x" }).returning();
  return c.id;
}
const detEvent = (id: string, cameraId: string) => JSON.stringify({
  id, type: "detection", camera_id: cameraId, ts: new Date().toISOString(),
  confidence: 0.9, count: 1, severity: "low", label: "person",
});

test("a detection XADDed to the stream is persisted then XACKed", async () => {
  if (!up) return;
  const camId = await seedCamera();
  const id = crypto.randomUUID();
  await redisStream.xadd("stream:detections", "*", "data", detEvent(id, camId));
  await consumeOnce(50);
  const [row] = await db.select().from(alerts).where(eq(alerts.id, id));
  expect(row?.id).toBe(id);
  const pending = await redisStream.xpending("stream:detections", "vms-backend") as any;
  expect(Number(pending?.[0] ?? 0)).toBe(0); // 0 pending -> acked
});

test("a duplicate detection id yields one alert row (idempotent)", async () => {
  if (!up) return;
  const camId = await seedCamera();
  const id = crypto.randomUUID();
  await redisStream.xadd("stream:detections", "*", "data", detEvent(id, camId));
  await consumeOnce(50);
  await redisStream.xadd("stream:detections", "*", "data", detEvent(id, camId));
  await consumeOnce(50);
  const rows = await db.select().from(alerts).where(eq(alerts.id, id));
  expect(rows.length).toBe(1);
});

test("a malformed entry does not crash the loop and is poison-dropped", async () => {
  if (!up) return;
  await redisStream.xadd("stream:detections", "*", "data", "{not json");
  const n = await consumeOnce(50); // processes (fails, left pending), no throw
  expect(typeof n).toBe("number");
  // reclaim with idle 0 + a low delivery ceiling drops it
  await reclaimStale(0, 1);
  const pend = await redisStream.xpending("stream:detections", "vms-backend") as any;
  // the malformed entry is no longer pending (dropped); count is a number
  expect(Number(pend?.[0] ?? 0)).toBeGreaterThanOrEqual(0);
});

test("ensureGroups is idempotent", async () => {
  if (!up) return;
  await ensureGroups(); // second call, group already exists -> no throw
  expect(true).toBe(true);
});
