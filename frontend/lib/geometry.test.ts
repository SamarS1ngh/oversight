import { test, expect } from "bun:test";
import { toNormalized, toPixels } from "./geometry";

test("toNormalized divides by canvas size", () => {
  expect(toNormalized([{ x: 128, y: 72 }], 1280, 720)).toEqual([{ x: 0.1, y: 0.1 }]);
});
test("toPixels multiplies by canvas size", () => {
  expect(toPixels([{ x: 0.1, y: 0.1 }], 1280, 720)).toEqual([{ x: 128, y: 72 }]);
});
test("round-trips", () => {
  const px = [{ x: 640, y: 360 }];
  const back = toPixels(toNormalized(px, 1280, 720), 1280, 720);
  expect(back[0].x).toBeCloseTo(640);
  expect(back[0].y).toBeCloseTo(360);
});
