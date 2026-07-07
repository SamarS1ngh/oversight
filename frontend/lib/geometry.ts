export type Pt = { x: number; y: number };
export const toNormalized = (pts: Pt[], w: number, h: number): Pt[] =>
  pts.map((p) => ({ x: p.x / w, y: p.y / h }));
export const toPixels = (poly: Pt[], w: number, h: number): Pt[] =>
  poly.map((p) => ({ x: p.x * w, y: p.y * h }));
