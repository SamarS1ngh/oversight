import { test, expect } from "bun:test";
import { sevRank, shouldNotify } from "../src/notify/filter";
import { allow, _reset } from "../src/notify/cooldown";

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
