import { test, expect } from "bun:test";
import { selectExpired, selectOverCap, type ClipRow } from "../src/realtime/retention";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
const rowAt = (id: string, tsMs: number, sizeBytes: number): ClipRow => ({
  id,
  path: `${id}.mp4`,
  thumbPath: null,
  sizeBytes,
  createdAt: new Date(tsMs),
});

test("selectExpired drops clips older than the retention window", () => {
  const rows = [rowAt("old", NOW - 8 * DAY, 10), rowAt("fresh", NOW - 1 * DAY, 10)];
  expect(selectExpired(rows, NOW, 7).map((r) => r.id)).toEqual(["old"]);
});

test("selectExpired keeps everything within the window", () => {
  const rows = [rowAt("a", NOW - 2 * DAY, 10)];
  expect(selectExpired(rows, NOW, 7)).toEqual([]);
});

test("selectOverCap drops oldest-first until total is under the cap", () => {
  const MB = 1024 * 1024;
  const rows = [rowAt("a", 1, 60 * MB), rowAt("b", 2, 60 * MB), rowAt("c", 3, 60 * MB)];
  expect(selectOverCap(rows, 120 * MB).map((r) => r.id)).toEqual(["a"]);
});

test("selectOverCap returns nothing when already under the cap", () => {
  const MB = 1024 * 1024;
  expect(selectOverCap([rowAt("a", 1, 10 * MB)], 100 * MB)).toEqual([]);
});
