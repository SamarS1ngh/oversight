import { test, expect } from "bun:test";
import { safeSnapshotPath } from "../src/notify/snapshot-url";

test("accepts the exact worker-produced shape", () => {
  expect(safeSnapshotPath("snapshots/cam/abc.jpg")).toBe("snapshots/cam/abc.jpg");
});

test("rejects path traversal", () => {
  expect(safeSnapshotPath("../../etc/passwd")).toBeNull();
  expect(safeSnapshotPath("snapshots/../x.jpg")).toBeNull();
});

test("rejects an absolute path", () => {
  expect(safeSnapshotPath("/abs/path.jpg")).toBeNull();
});

test("rejects non-string values", () => {
  expect(safeSnapshotPath(42)).toBeNull();
  expect(safeSnapshotPath(null)).toBeNull();
});
