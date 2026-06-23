import { test, expect, beforeAll } from "bun:test";
import { sql } from "drizzle-orm";
import { app } from "../src/app";
import { db } from "../src/db";

// Integration tests against a live Postgres. They self-skip if no DB is
// reachable, so `bun test` still passes the unit suite without infra.
// To run these: have the compose Postgres up and
//   DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun test

let dbUp = false;
beforeAll(async () => {
  try {
    await db.execute(sql`select 1`);
    dbUp = true;
  } catch {
    dbUp = false;
  }
});

function call(path: string, opts: RequestInit = {}) {
  return app.fetch(new Request(`http://test${path}`, opts));
}
const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const rnd = () => Math.random().toString(36).slice(2, 9);

test("GET /health is 200", async () => {
  const r = await call("/health");
  expect(r.status).toBe(200);
});

test("protected route rejects a missing token", async () => {
  const r = await call("/me");
  expect(r.status).toBe(401);
});

test("signup -> /me -> create camera; other users cannot see it", async () => {
  if (!dbUp) {
    console.warn("  (skipped — no Postgres reachable)");
    return;
  }
  const user = "it_" + rnd();
  let r = await call("/auth/signup", json({ username: user, password: "secret12" }));
  expect(r.status).toBe(201);
  const { token } = await r.json();

  r = await call("/me", { headers: { Authorization: `Bearer ${token}` } });
  expect(r.status).toBe(200);

  r = await call("/cameras", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "T", rtsp_url: "rtsp://x/y", location: "L" }),
  });
  expect(r.status).toBe(201);
  const cam = await r.json();
  expect(cam.name).toBe("T");

  // a second user must not be able to read the first user's camera
  r = await call("/auth/signup", json({ username: "it2_" + rnd(), password: "secret12" }));
  const { token: token2 } = await r.json();
  r = await call(`/cameras/${cam.id}`, {
    headers: { Authorization: `Bearer ${token2}` },
  });
  expect(r.status).toBe(404);
});

test("alerts endpoint rejects a non-uuid camera_id", async () => {
  if (!dbUp) return;
  const r = await call("/auth/signup", json({ username: "it3_" + rnd(), password: "secret12" }));
  const { token } = await r.json();
  const res = await call("/alerts?camera_id=not-a-uuid", {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(400);
});
