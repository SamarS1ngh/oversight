import { test, expect, beforeAll } from "bun:test";
import { sql } from "drizzle-orm";
import { app } from "../src/app";
import { db } from "../src/db";
import { clips } from "../src/db/schema";

let dbUp = false;
beforeAll(async () => {
  try {
    await db.execute(sql`select 1`);
    dbUp = true;
  } catch {
    dbUp = false;
  }
});

const call = (path: string, opts: RequestInit = {}) =>
  app.fetch(new Request(`http://test${path}`, opts));
const json = (b: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(b),
});
const rnd = () => Math.random().toString(36).slice(2, 9);

test("GET /clips without a token is 401", async () => {
  const r = await call("/clips");
  expect(r.status).toBe(401);
});

test("GET /clips rejects a non-uuid camera_id", async () => {
  if (!dbUp) return;
  const r = await call("/auth/signup", json({ username: "clip_" + rnd(), password: "secret12" }));
  const { token } = await r.json();
  const res = await call("/clips?camera_id=not-a-uuid", {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(400);
});

test("GET /clips returns an empty list for a fresh user", async () => {
  if (!dbUp) return;
  const r = await call("/auth/signup", json({ username: "clip2_" + rnd(), password: "secret12" }));
  const { token } = await r.json();
  const res = await call("/clips", { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.clips).toEqual([]);
  expect(body).toHaveProperty("count", 0);
});

// Signs up a fresh user, creates a camera for them, and inserts one clip row
// directly on that camera. Returns the user's token, the clip id, and a
// bound `authed` helper for making requests as this user.
async function makeUserWithClip() {
  const signup = await call(
    "/auth/signup",
    json({ username: "clipu_" + rnd(), password: "secret12" }),
  );
  const { token } = await signup.json();
  const authed = (path: string, opts: RequestInit = {}) =>
    call(path, {
      ...opts,
      headers: { ...(opts.headers ?? {}), Authorization: `Bearer ${token}` },
    });

  const camRes = await authed(
    "/cameras",
    json({ name: "cam-" + rnd(), rtsp_url: "rtsp://example.com/stream" }),
  );
  const cam = await camRes.json();

  const clipId = crypto.randomUUID();
  const now = new Date();
  await db.insert(clips).values({
    id: clipId,
    cameraId: cam.id,
    startTs: now,
    endTs: now,
    durationMs: 20000,
    sizeBytes: 1000,
    path: "cam/x.mp4",
    backend: "local",
  });

  return { token, clipId, authed };
}

test("clips are scoped to the owning user: another user cannot list or delete them", async () => {
  if (!dbUp) return;

  const a = await makeUserWithClip();
  const signupB = await call(
    "/auth/signup",
    json({ username: "clipb_" + rnd(), password: "secret12" }),
  );
  const { token: tokenB } = await signupB.json();

  const listAsB = await call("/clips", { headers: { Authorization: `Bearer ${tokenB}` } });
  expect(listAsB.status).toBe(200);
  expect((await listAsB.json()).clips).toEqual([]);

  const listAsA = await a.authed("/clips");
  expect(listAsA.status).toBe(200);
  const bodyA = await listAsA.json();
  expect(bodyA.count).toBe(1);
  expect(bodyA.clips.map((cl: any) => cl.id)).toContain(a.clipId);

  const deleteAsB = await call(`/clips/${a.clipId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${tokenB}` },
  });
  expect(deleteAsB.status).toBe(404);
});

test("DELETE /clips/:id as the owner removes the clip", async () => {
  if (!dbUp) return;

  const a = await makeUserWithClip();

  const del = await a.authed(`/clips/${a.clipId}`, { method: "DELETE" });
  expect(del.status).toBe(204);

  const after = await a.authed("/clips");
  expect((await after.json()).clips).toEqual([]);
});

test("GET /clips/:id/video 404s for an unknown id (token via query)", async () => {
  if (!dbUp) return;
  const r = await call("/auth/signup", json({ username: "clip3_" + rnd(), password: "secret12" }));
  const { token } = await r.json();
  const res = await call(`/clips/11111111-1111-1111-1111-111111111111/video?token=${token}`);
  expect(res.status).toBe(404);
});

test("GET /clips/:id/video without any token is 401", async () => {
  const res = await call("/clips/11111111-1111-1111-1111-111111111111/video");
  expect(res.status).toBe(401);
});
