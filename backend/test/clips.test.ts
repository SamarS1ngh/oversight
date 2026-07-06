import { test, expect, beforeAll } from "bun:test";
import { sql } from "drizzle-orm";
import { app } from "../src/app";
import { db } from "../src/db";

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
