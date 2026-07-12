import { test, expect, beforeAll } from "bun:test";
import { sql } from "drizzle-orm";
import { app } from "../src/app";
import { db } from "../src/db";
import { alerts } from "../src/db/schema";
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

test("create a line zone (exactly 2 points)", async () => {
  if (!dbUp) return;
  const a = await user();
  const ok = await a.authed(`/cameras/${a.cam.id}/zones`, json({ name: "gate", kind: "line", polygon: [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }] }));
  expect(ok.status).toBe(201);
  expect((await ok.json()).kind).toBe("line");
});

test("reject a line zone without exactly 2 points", async () => {
  if (!dbUp) return;
  const a = await user();
  const bad = await a.authed(`/cameras/${a.cam.id}/zones`, json({ name: "bad", kind: "line", polygon: [{ x: 0.2, y: 0.5 }] }));
  expect(bad.status).toBe(400);
  const bad3 = await a.authed(`/cameras/${a.cam.id}/zones`, json({ name: "bad3", kind: "line", polygon: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 }, { x: 0.9, y: 0.9 }] }));
  expect(bad3.status).toBe(400);
});

test("PATCH kind to line without new points is rejected when existing points don't fit", async () => {
  if (!dbUp) return;
  const a = await user();
  // a 3-point polygon zone
  const poly = await (await a.authed(`/cameras/${a.cam.id}/zones`, json({ name: "P", polygon: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.5, y: 0.9 }] }))).json();
  // relabel it a line without giving 2 points -> 400 (would leave a "line" with 3 points)
  const bad = await a.authed(`/cameras/${a.cam.id}/zones/${poly.id}`, { method: "PATCH", body: JSON.stringify({ kind: "line" }) });
  expect(bad.status).toBe(400);
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

test("PATCH cannot clear a tripwire's line zone (explicit null) into an invalid rule", async () => {
  if (!dbUp) return;
  const a = await user();
  const line = await (await a.authed(`/cameras/${a.cam.id}/zones`, json({ name: "L", kind: "line", polygon: [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }] }))).json();
  const rule = await (await a.authed(`/cameras/${a.cam.id}/rules`, json({ name: "cross", type: "tripwire", classes: ["person"], zoneId: line.id, direction: "in" }))).json();
  // explicit null zoneId must be validated as the new value (tripwire needs a line zone) -> 400
  const cleared = await a.authed(`/cameras/${a.cam.id}/rules/${rule.id}`, { method: "PATCH", body: JSON.stringify({ zoneId: null }) });
  expect(cleared.status).toBe(400);
  // dropping the direction to null is likewise rejected
  const noDir = await a.authed(`/cameras/${a.cam.id}/rules/${rule.id}`, { method: "PATCH", body: JSON.stringify({ direction: null }) });
  expect(noDir.status).toBe(400);
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

test("tripwire rule requires a line zone + direction; dwell requires a polygon zone + seconds", async () => {
  if (!dbUp) return;
  const a = await user();
  const line = await (await a.authed(`/cameras/${a.cam.id}/zones`, json({ name: "L", kind: "line", polygon: [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }] }))).json();
  const poly = await (await a.authed(`/cameras/${a.cam.id}/zones`, json({ name: "P", kind: "polygon", polygon: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.5, y: 0.9 }] }))).json();
  // valid tripwire
  const tw = await a.authed(`/cameras/${a.cam.id}/rules`, json({ name: "cross", type: "tripwire", classes: ["person"], zoneId: line.id, direction: "in", severity: "high" }));
  expect(tw.status).toBe(201);
  // tripwire pointing at a polygon zone -> 400
  const twBad = await a.authed(`/cameras/${a.cam.id}/rules`, json({ name: "bad", type: "tripwire", classes: ["person"], zoneId: poly.id, direction: "in" }));
  expect(twBad.status).toBe(400);
  // tripwire missing direction -> 400
  const twNoDir = await a.authed(`/cameras/${a.cam.id}/rules`, json({ name: "bad2", type: "tripwire", classes: ["person"], zoneId: line.id }));
  expect(twNoDir.status).toBe(400);
  // valid dwell
  const dw = await a.authed(`/cameras/${a.cam.id}/rules`, json({ name: "loiter", type: "dwell", classes: ["person"], zoneId: poly.id, dwellSeconds: 5 }));
  expect(dw.status).toBe(201);
  // dwell on a line zone -> 400
  const dwBad = await a.authed(`/cameras/${a.cam.id}/rules`, json({ name: "bad3", type: "dwell", classes: ["person"], zoneId: line.id, dwellSeconds: 5 }));
  expect(dwBad.status).toBe(400);
  // dwell without seconds -> 400
  const dwNoS = await a.authed(`/cameras/${a.cam.id}/rules`, json({ name: "bad4", type: "dwell", classes: ["person"], zoneId: poly.id }));
  expect(dwNoS.status).toBe(400);
});

test("resolveRules returns type/direction/dwell_seconds", async () => {
  if (!dbUp) return;
  const a = await user();
  const line = await (await a.authed(`/cameras/${a.cam.id}/zones`, json({ name: "L", kind: "line", polygon: [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }] }))).json();
  await a.authed(`/cameras/${a.cam.id}/rules`, json({ name: "cross", type: "tripwire", classes: ["person"], zoneId: line.id, direction: "out", severity: "high" }));
  const { resolveRules } = await import("../src/rules/routes");
  const resolved = await resolveRules(a.cam.id);
  const tw = resolved.find((r: any) => r.type === "tripwire");
  expect(tw.direction).toBe("out");
  expect(tw.zone).toEqual([{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }]);
});

test("alerts severity/status filter + ack + resolve", async () => {
  if (!dbUp) return;
  const a = await user();
  const id = crypto.randomUUID();
  await db.insert(alerts).values({ id, cameraId: a.cam.id, type: "detection", ts: new Date(), confidence: 0.9, count: 1, label: "person", severity: "high", status: "new" });
  // filter by severity
  const hi = await (await a.authed(`/alerts?severity=high`)).json();
  expect(hi.alerts.some((x: any) => x.id === id)).toBe(true);
  const lo = await (await a.authed(`/alerts?severity=low`)).json();
  expect(lo.alerts.some((x: any) => x.id === id)).toBe(false);
  // ack
  const ack = await a.authed(`/alerts/${id}/ack`, { method: "POST" });
  expect(ack.status).toBe(200);
  const acked = await (await a.authed(`/alerts?status=acked`)).json();
  expect(acked.alerts.some((x: any) => x.id === id)).toBe(true);
  // resolve
  const res = await a.authed(`/alerts/${id}/resolve`, { method: "POST" });
  expect(res.status).toBe(200);
  // another user cannot ack it
  const b = await user();
  const bad = await b.authed(`/alerts/${id}/ack`, { method: "POST" });
  expect(bad.status).toBe(404);
});
