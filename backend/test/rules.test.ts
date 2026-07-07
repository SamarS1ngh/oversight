import { test, expect, beforeAll } from "bun:test";
import { sql } from "drizzle-orm";
import { app } from "../src/app";
import { db } from "../src/db";
import { resolveRules } from "../src/rules/routes";

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

test("create a rule with a zone + validate inputs", async () => {
  if (!dbUp) return;
  const a = await user();
  const zone = await (await a.authed(`/cameras/${a.cam.id}/zones`, json({ name: "Z", polygon: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.5, y: 0.9 }] }))).json();
  const ok = await a.authed(`/cameras/${a.cam.id}/rules`, json({ name: "night", classes: ["person", "car"], zoneId: zone.id, scheduleStart: "22:00", scheduleEnd: "06:00", severity: "high" }));
  expect(ok.status).toBe(201);
  const rule = await ok.json();
  expect(rule.severity).toBe("high");
  const list = await (await a.authed(`/cameras/${a.cam.id}/rules`)).json();
  expect(list.map((r: any) => r.id)).toContain(rule.id);
});

test("reject unknown class, bad severity, bad schedule", async () => {
  if (!dbUp) return;
  const a = await user();
  const badClass = await a.authed(`/cameras/${a.cam.id}/rules`, json({ name: "x", classes: ["dragon"] }));
  expect(badClass.status).toBe(400);
  const badSev = await a.authed(`/cameras/${a.cam.id}/rules`, json({ name: "x", classes: ["person"], severity: "urgent" }));
  expect(badSev.status).toBe(400);
  const badTime = await a.authed(`/cameras/${a.cam.id}/rules`, json({ name: "x", classes: ["person"], scheduleStart: "9am" }));
  expect(badTime.status).toBe(400);
});

test("a rule cannot reference another camera's zone (POST or PATCH)", async () => {
  if (!dbUp) return;
  const a = await user();
  const b = await user();
  // b's zone, on b's camera
  const bZone = await (await b.authed(`/cameras/${b.cam.id}/zones`, json({ name: "bz", polygon: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.5, y: 0.9 }] }))).json();
  // a tries to POST a rule on a's camera referencing b's zone -> 400
  const post = await a.authed(`/cameras/${a.cam.id}/rules`, json({ name: "steal", classes: ["person"], zoneId: bZone.id }));
  expect(post.status).toBe(400);
  // a creates a valid rule, then tries to PATCH its zone to b's zone -> 400
  const rule = await (await a.authed(`/cameras/${a.cam.id}/rules`, json({ name: "ok", classes: ["person"] }))).json();
  const patch = await a.authed(`/cameras/${a.cam.id}/rules/${rule.id}`, { method: "PATCH", body: JSON.stringify({ zoneId: bZone.id }) });
  expect(patch.status).toBe(400);
});

test("resolveRules inlines the zone polygon and only returns enabled rules", async () => {
  if (!dbUp) return;
  const a = await user();
  const poly = [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.5, y: 0.9 }];
  const zone = await (await a.authed(`/cameras/${a.cam.id}/zones`, json({ name: "Z", polygon: poly }))).json();
  await a.authed(`/cameras/${a.cam.id}/rules`, json({ name: "on", classes: ["person"], zoneId: zone.id, severity: "high" }));
  await a.authed(`/cameras/${a.cam.id}/rules`, json({ name: "off", classes: ["car"], enabled: false }));
  const resolved = await resolveRules(a.cam.id);
  expect(resolved.length).toBe(1);
  expect(resolved[0].zone).toEqual(poly);
  expect(resolved[0].classes).toEqual(["person"]);
  expect(resolved[0].severity).toBe("high");
});
