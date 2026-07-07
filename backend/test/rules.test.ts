import { test, expect, beforeAll } from "bun:test";
import { sql } from "drizzle-orm";
import { app } from "../src/app";
import { db } from "../src/db";

let dbUp = false;
beforeAll(async () => {
  try { await db.execute(sql`select 1`); dbUp = true; } catch { dbUp = false; }
});
const call = (p: string, o: RequestInit = {}) => app.fetch(new Request(`http://test${p}`, o));
const json = (b: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
const rnd = () => Math.random().toString(36).slice(2, 9);
async function user() {
  const r = await call("/auth/signup", json({ username: "r_" + rnd(), password: "secret12" }));
  const { token } = await r.json();
  const authed = (p: string, o: RequestInit = {}) => call(p, { ...o, headers: { ...(o.headers ?? {}), Authorization: `Bearer ${token}` } });
  const cam = await (await authed("/cameras", json({ name: "c", rtsp_url: "rtsp://x/y" }))).json();
  return { token, authed, cam };
}

test("zones require auth", async () => {
  const r = await call("/cameras/11111111-1111-1111-1111-111111111111/zones");
  expect(r.status).toBe(401);
});

test("create + list a zone, scoped to the owner", async () => {
  if (!dbUp) return;
  const a = await user();
  const created = await a.authed(`/cameras/${a.cam.id}/zones`, json({ name: "Driveway", polygon: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.5, y: 0.9 }] }));
  expect(created.status).toBe(201);
  const zone = await created.json();
  expect(zone.name).toBe("Driveway");
  const list = await (await a.authed(`/cameras/${a.cam.id}/zones`)).json();
  expect(list.map((z: any) => z.id)).toContain(zone.id);
  // another user cannot see it
  const b = await user();
  const bl = await b.authed(`/cameras/${a.cam.id}/zones`);
  expect(bl.status).toBe(404);
});

test("reject a polygon with fewer than 3 points", async () => {
  if (!dbUp) return;
  const a = await user();
  const r = await a.authed(`/cameras/${a.cam.id}/zones`, json({ name: "bad", polygon: [{ x: 0.1, y: 0.1 }] }));
  expect(r.status).toBe(400);
});
