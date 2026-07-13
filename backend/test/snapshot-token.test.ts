import { test, expect } from "bun:test";
import { signSnapshotToken, verifySnapshotToken } from "../src/notify/snapshot-token";

const A = "11111111-1111-1111-1111-111111111111";

test("a fresh token verifies for its alert", () => {
  const t = signSnapshotToken(A, 1000, 60_000);
  expect(verifySnapshotToken(A, t, 2000)).toBe(true);
});

test("a token for another alert is rejected", () => {
  const t = signSnapshotToken(A, 1000, 60_000);
  expect(verifySnapshotToken("22222222-2222-2222-2222-222222222222", t, 2000)).toBe(false);
});

test("an expired token is rejected", () => {
  const t = signSnapshotToken(A, 1000, 60_000);
  expect(verifySnapshotToken(A, t, 1000 + 60_001)).toBe(false);
});

test("a tampered token is rejected", () => {
  const t = signSnapshotToken(A, 1000, 60_000);
  expect(verifySnapshotToken(A, t.replace(/.$/, (c) => (c === "0" ? "1" : "0")), 2000)).toBe(false);
});

test("a multibyte-char signature of equal code-unit length is rejected, not thrown", () => {
  const t = signSnapshotToken(A, 1000, 60_000);
  const exp = t.slice(0, t.indexOf(".") + 1);
  const forged = exp + "a".repeat(63) + "é"; // .length 64 like the real 64-hex mac, but 65 bytes
  expect(verifySnapshotToken(A, forged, 2000)).toBe(false);
});

test("a token with no delimiter is rejected", () => {
  expect(verifySnapshotToken(A, "notatoken", 2000)).toBe(false);
});

test("a non-numeric exp is rejected", () => {
  expect(verifySnapshotToken(A, "abc.deadbeef", 2000)).toBe(false);
});
