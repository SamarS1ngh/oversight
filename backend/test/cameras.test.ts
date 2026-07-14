import { test, expect, beforeAll } from "bun:test";
import { sql, eq } from "drizzle-orm";
import { db } from "../src/db";
import { cameras } from "../src/db/schema";
import { app } from "../src/app";

// DB-gated smoke test: cameras table now has lastSeenAt + notifyOnOffline columns.
// To run: DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun test test/cameras.test.ts
// (Skips gracefully if Postgres is unreachable, so `bun test` still passes the unit suite without infra.)

let dbUp = false;
beforeAll(async () => {
  try {
    await db.execute(sql`select 1`);
    dbUp = true;
  } catch {
    dbUp = false;
  }
});

test("cameras carry lastSeenAt + notifyOnOffline", async () => {
  if (!dbUp) return;
  const rows = await db.select({ a: cameras.lastSeenAt, b: cameras.notifyOnOffline }).from(cameras).limit(1);
  expect(Array.isArray(rows)).toBe(true);
});

const call = (p: string, o: RequestInit = {}) => app.fetch(new Request(`http://test${p}`, o));
const json = (b: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
const rnd = () => Math.random().toString(36).slice(2, 9);
async function nuser() {
  const r = await call("/auth/signup", json({ username: "n_" + rnd(), password: "secret12" }));
  const { token } = await r.json();
  return (p: string, o: RequestInit = {}) => call(p, { ...o, headers: { ...(o.headers ?? {}), Authorization: `Bearer ${token}` } });
}

test("PATCH /cameras/:id toggles notifyOnOffline", async () => {
  if (!dbUp) return;
  const a = await nuser();
  const cam = await (await a(`/cameras`, json({ name: "C2", rtsp_url: "rtsp://x" }))).json();
  expect(cam.notifyOnOffline).toBe(false);
  const upd = await (await a(`/cameras/${cam.id}`, { ...json({ notify_on_offline: true }), method: "PATCH" })).json();
  expect(upd.notifyOnOffline).toBe(true);
});

test("applyCameraState: offline transition on an opted-in camera dispatches; opted-out does not", async () => {
  if (!dbUp) return;
  const a = await nuser();
  let hits = 0;
  const server = Bun.serve({ port: 0, fetch() { hits++; return new Response("ok"); } });
  const cam = await (await a(`/cameras`, json({ name: "C", rtsp_url: "rtsp://x" }))).json();
  await a(`/notifications`, json({ type: "webhook", name: "h", config: { url: `http://127.0.0.1:${server.port}/h` }, minSeverity: "low", cooldownSecs: 0 }));
  const { applyCameraState } = await import("../src/realtime/ingest");
  // opted OUT (default) -> no dispatch even on an offline transition
  await applyCameraState({ type: "camera_state", camera_id: cam.id, state: "live" });
  await applyCameraState({ type: "camera_state", camera_id: cam.id, state: "offline" });
  await new Promise((r) => setTimeout(r, 40));
  expect(hits).toBe(0);
  // opt in via a direct DB update (no dependency on Task 6's PATCH), then a
  // recovery transition (prev offline -> live) dispatches
  await db.update(cameras).set({ notifyOnOffline: true }).where(eq(cameras.id, cam.id));
  await applyCameraState({ type: "camera_state", camera_id: cam.id, state: "live" });
  await new Promise((r) => setTimeout(r, 40));
  expect(hits).toBeGreaterThanOrEqual(1);
  server.stop();
});

test("applyCameraState: lastSeenAt is stamped from camera_stats.last_frame_at, not camera_state", async () => {
  if (!dbUp) return;
  const { applyCameraState } = await import("../src/realtime/ingest");
  const a = await nuser();
  const cam = await (await a(`/cameras`, json({ name: "C3", rtsp_url: "rtsp://x" }))).json();
  const t1 = new Date("2026-07-01T00:00:00.000Z").toISOString();
  await applyCameraState({ type: "camera_stats", camera_id: cam.id, last_frame_at: t1 });
  let [row] = await db.select({ lastSeenAt: cameras.lastSeenAt }).from(cameras).where(eq(cameras.id, cam.id)).limit(1);
  expect(row.lastSeenAt?.toISOString()).toBe(t1);

  const t2 = new Date("2026-07-02T00:00:00.000Z").toISOString();
  await applyCameraState({ type: "camera_stats", camera_id: cam.id, last_frame_at: t2 });
  [row] = await db.select({ lastSeenAt: cameras.lastSeenAt }).from(cameras).where(eq(cameras.id, cam.id)).limit(1);
  expect(row.lastSeenAt?.toISOString()).toBe(t2);

  // a camera_state transition must not touch lastSeenAt
  await applyCameraState({ type: "camera_state", camera_id: cam.id, state: "offline" });
  [row] = await db.select({ lastSeenAt: cameras.lastSeenAt }).from(cameras).where(eq(cameras.id, cam.id)).limit(1);
  expect(row.lastSeenAt?.toISOString()).toBe(t2);
});
