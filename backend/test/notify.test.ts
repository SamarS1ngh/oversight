import { test, expect } from "bun:test";
import { sevRank, shouldNotify } from "../src/notify/filter";
import { allow, _reset } from "../src/notify/cooldown";
import { renderAlert } from "../src/notify/render";
import { buildRequest } from "../src/notify/drivers";

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
