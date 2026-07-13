import { test, expect, beforeAll } from "bun:test";
import { sql } from "drizzle-orm";
import { sevRank, shouldNotify } from "../src/notify/filter";
import { allow, _reset } from "../src/notify/cooldown";
import { renderAlert } from "../src/notify/render";
import { buildRequest } from "../src/notify/drivers";
import { app } from "../src/app";
import { db } from "../src/db";
import { notificationDeliveries } from "../src/db/schema";

test("sevRank orders severities", () => {
  expect(sevRank("low")).toBe(0);
  expect(sevRank("high")).toBeGreaterThan(sevRank("medium"));
});

test("shouldNotify respects min severity", () => {
  const ch = { minSeverity: "high", cameraIds: null } as any;
  expect(shouldNotify(ch, { severity: "high", camera_id: "c1" })).toBe(true);
  expect(shouldNotify(ch, { severity: "low", camera_id: "c1" })).toBe(false);
});

test("shouldNotify respects the camera set (null = all)", () => {
  const all = { minSeverity: "low", cameraIds: null } as any;
  const one = { minSeverity: "low", cameraIds: ["c1"] } as any;
  expect(shouldNotify(all, { severity: "low", camera_id: "cX" })).toBe(true);
  expect(shouldNotify(one, { severity: "low", camera_id: "c1" })).toBe(true);
  expect(shouldNotify(one, { severity: "low", camera_id: "c2" })).toBe(false);
});

test("cooldown allows first, suppresses within window, allows after", () => {
  _reset();
  expect(allow("k", 0, 60)).toBe(true);
  expect(allow("k", 30_000, 60)).toBe(false);
  expect(allow("k", 61_000, 60)).toBe(true);
});

test("cooldown of 0 always allows", () => {
  _reset();
  expect(allow("z", 0, 0)).toBe(true);
  expect(allow("z", 1, 0)).toBe(true);
});

const ALERT = { id: "a1", severity: "high", label: "person", rule_id: "r1", camera_id: "c1", ts: "2026-07-13T22:32:00.000Z", count: 2, confidence: 0.91 };
const LINK = "http://app/events?camera=c1";

test("renderAlert webhook payload maps snake->camel + includes link", () => {
  const p: any = renderAlert("webhook", ALERT, "Driveway", "Night", LINK);
  expect(p.event).toBe("alert");
  expect(p.alert.cameraId).toBe("c1");
  expect(p.alert.severity).toBe("high");
  expect(p.camera.name).toBe("Driveway");
  expect(p.rule.name).toBe("Night");
  expect(p.url).toBe(LINK);
});

test("renderAlert ntfy maps severity to priority + carries click", () => {
  const p: any = renderAlert("ntfy", ALERT, "Driveway", "Night", LINK);
  expect(p.priority).toBe(5); // high
  expect(p.click).toBe(LINK);
  expect(p.title).toContain("Driveway");
});

test("renderAlert telegram has markdown text with the link", () => {
  const p: any = renderAlert("telegram", ALERT, "Driveway", null, LINK);
  expect(p.parse_mode).toBe("Markdown");
  expect(p.text).toContain(LINK);
  expect(p.text).toContain("detection"); // null ruleName -> "detection"
});

test("buildRequest webhook is a JSON POST to config.url", () => {
  const r = buildRequest("webhook", { url: "http://hook" }, { event: "alert" });
  expect(r.url).toBe("http://hook");
  expect(r.method).toBe("POST");
  expect(r.headers["content-type"]).toBe("application/json");
  expect(JSON.parse(r.body).event).toBe("alert");
});

test("buildRequest ntfy posts to server/topic with headers + optional auth", () => {
  const p = { title: "T", body: "B", priority: 5, tags: ["high"], click: LINK };
  const noAuth = buildRequest("ntfy", { topic: "mytopic" }, p);
  expect(noAuth.url).toBe("https://ntfy.sh/mytopic");
  expect(noAuth.headers["Title"]).toBe("T");
  expect(noAuth.headers["Priority"]).toBe("5");
  expect(noAuth.headers["Authorization"]).toBeUndefined();
  expect(noAuth.body).toBe("B");
  const auth = buildRequest("ntfy", { topic: "t", server: "https://n.example", token: "tok" }, p);
  expect(auth.url).toBe("https://n.example/t");
  expect(auth.headers["Authorization"]).toBe("Bearer tok");
});

test("buildRequest telegram posts to the bot sendMessage with chat_id", () => {
  const r = buildRequest("telegram", { botToken: "BT", chatId: "123" }, { text: "hi", parse_mode: "Markdown" });
  expect(r.url).toBe("https://api.telegram.org/botBT/sendMessage");
  const b = JSON.parse(r.body);
  expect(b.chat_id).toBe("123");
  expect(b.text).toBe("hi");
});

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
const call = (p: string, o: RequestInit = {}) => app.fetch(new Request(`http://test${p}`, o));
const json = (b: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
const rnd = () => Math.random().toString(36).slice(2, 9);
async function nuser() {
  const r = await call("/auth/signup", json({ username: "n_" + rnd(), password: "secret12" }));
  const { token } = await r.json();
  return (p: string, o: RequestInit = {}) => call(p, { ...o, headers: { ...(o.headers ?? {}), Authorization: `Bearer ${token}` } });
}

test("notifications require auth", async () => {
  expect((await call("/notifications")).status).toBe(401);
});

test("create + list a channel, owner-scoped", async () => {
  if (!dbUp) return;
  const a = await nuser();
  const created = await a(`/notifications`, json({ type: "ntfy", name: "phone", config: { topic: "mytopic" }, minSeverity: "high" }));
  expect(created.status).toBe(201);
  const ch = await created.json();
  expect(ch.type).toBe("ntfy");
  const list = await (await a(`/notifications`)).json();
  expect(list.map((x: any) => x.id)).toContain(ch.id);
  // another user can't see / delete it
  const b = await nuser();
  expect((await b(`/notifications/${ch.id}`, { method: "DELETE" })).status).toBe(404);
});

test("validation: bad type / missing per-type config / bad severity", async () => {
  if (!dbUp) return;
  const a = await nuser();
  expect((await a(`/notifications`, json({ type: "carrier-pigeon", name: "x", config: {} }))).status).toBe(400);
  expect((await a(`/notifications`, json({ type: "webhook", name: "x", config: {} }))).status).toBe(400); // no url
  expect((await a(`/notifications`, json({ type: "telegram", name: "x", config: { botToken: "b" } }))).status).toBe(400); // no chatId
  expect((await a(`/notifications`, json({ type: "ntfy", name: "x", config: { topic: "t" }, minSeverity: "urgent" }))).status).toBe(400);
});

test("validation: non-string name / NaN cooldown / non-boolean enabled → 400 not 500", async () => {
  if (!dbUp) return;
  const a = await nuser();
  // name a number would throw on .trim() without the typeof guard (500)
  expect((await a(`/notifications`, json({ type: "webhook", name: 42, config: { url: "http://h" } }))).status).toBe(400);
  // NaN passes a naive `typeof === number && >= 0` check
  expect((await a(`/notifications`, json({ type: "webhook", name: "x", config: { url: "http://h" }, cooldownSecs: NaN }))).status).toBe(400);
  // non-boolean enabled would be written raw to a boolean column
  expect((await a(`/notifications`, json({ type: "webhook", name: "x", config: { url: "http://h" }, enabled: "yes" }))).status).toBe(400);
});

test("PATCH re-validates the merged channel (non-boolean enabled → 400)", async () => {
  if (!dbUp) return;
  const a = await nuser();
  const ch = await (await a(`/notifications`, json({ type: "webhook", name: "h", config: { url: "http://h" } }))).json();
  const bad = await a(`/notifications/${ch.id}`, { ...json({ enabled: "nope" }), method: "PATCH" });
  expect(bad.status).toBe(400);
});

test("POST /notifications/:id/test delivers to a webhook", async () => {
  if (!dbUp) return;
  const a = await nuser();
  // a local server that captures the POST
  let received: any = null;
  const server = Bun.serve({ port: 0, async fetch(req) { received = await req.json(); return new Response("ok"); } });
  const url = `http://127.0.0.1:${server.port}/hook`;
  const ch = await (await a(`/notifications`, json({ type: "webhook", name: "hook", config: { url } }))).json();
  const res = await a(`/notifications/${ch.id}/test`, { method: "POST" });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(received?.event).toBe("alert");
  expect(received?.alert?.severity).toBe("high");
  server.stop();
});

test("notification_deliveries table is queryable", async () => {
  if (!dbUp) return;
  const rows = await db.select().from(notificationDeliveries).limit(1);
  expect(Array.isArray(rows)).toBe(true);
});
