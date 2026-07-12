# M2b Tracking Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two rule types that need object identity across frames — **tripwire** (a tracked object crosses a line) and **dwell** (a tracked object stays in a zone ≥ N seconds) — on top of the M2a rules engine.

**Architecture:** Each `CameraWorker` gets a per-camera object tracker (standalone ByteTrack from `supervision`, behind a swappable `Tracker` interface). Each detect frame: `detect_objects` → `tracker.update` → `list[Track]`. **Presence** rules (M2a) still evaluate on raw boxes, unchanged. **Tripwire/dwell** rules evaluate on the *tracks* + a little per-rule state kept on the worker; matches emit the same detection event → alert, reusing all M2a delivery/dedup/ack/UI. The API stores the new rule fields and inlines them in the rules pushed to the worker.

**Tech Stack:** Bun + Hono 4 + Drizzle 0.36 (Postgres), Python + ultralytics YOLOv8n + **supervision (ByteTrack)** + PyAV/OpenCV, Next.js 15 / React 19, Redis pub/sub.

## Global Constraints

- **Tracker is standalone ByteTrack, one per `CameraWorker`, behind a `Tracker` interface** — never `model.track()` (the shared YOLO model would bleed track IDs across cameras).
- **Track reference point = box bottom-center** `(x + w/2, y + h)`, normalized — same as M2a's in-zone test.
- **Dwell fires once per episode:** alert when continuous time-in-zone first reaches `dwellSeconds`; reset when the track leaves the zone or disappears; re-entry = new episode.
- **Tripwire fires once per crossing;** a track needs ≥2 observed positions.
- **Tracking matches BYPASS the M2a count-dedup limiter** (tripwire once-per-crossing and dwell once-per-episode are self-limiting; the count-window dedup would wrongly suppress a second person). Presence matches keep the M2a per-(camera,rule) dedup.
- **Implicit "any person, low" default fires only when the camera has ZERO rules of any type.** A camera with only tracking rules has NO presence default.
- **Defaults:** `direction = both`, `dwellSeconds = 10`.
- **Rule-type / zone-kind pairing:** `tripwire` requires a `line`-kind zone (exactly 2 points) + a `direction`; `dwell` requires a `polygon`-kind zone (≥3 points) + `dwellSeconds > 0`; `presence` is unchanged (whole-frame or polygon zone).
- **Event contract single source of truth:** `docs/EVENT_FORMAT.md`. The `start`/`rules_update` `rules` payload gains `type`/`direction`/`dwell_seconds`.
- **Import-light worker:** pure logic (`tracking_rules.py`) unit-tests without `supervision`/`numpy`/`torch`; heavy imports stay local to `tracker.py`'s `ByteTrackTracker` (Docker-only, verified at e2e — like `recorder_io.py`/`detector.py`).
- **Ownership scoping unchanged:** zones/rules via `ownedCamera` / `zoneBelongs`.
- **Commits:** author is Samar only. No `Co-Authored-By: Claude` trailer.
- Commands: backend `cd backend && bun test` (DB-backed need `DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms`); migrate `cd backend && bun run db:push`; worker pure tests `cd worker && python3 -m unittest discover -s tests -v`; frontend `cd frontend && npm run build`.

---

### Task 1: `zones.kind` + `rules` tracking columns + migration

**Files:**
- Modify: `backend/src/db/schema.ts`

**Interfaces:**
- Produces: `zones.kind` (text, default `'polygon'`); `rules.type` (text, default `'presence'`), `rules.direction` (text, nullable), `rules.dwellSeconds` (integer, nullable).

- [ ] **Step 1: Add the columns**

In `backend/src/db/schema.ts`, add to the `zones` columns (after `polygon`):

```ts
    kind: text("kind").notNull().default("polygon"), // 'polygon' | 'line'
```

Add to the `rules` columns (after `zoneId`):

```ts
    type: text("type").notNull().default("presence"), // 'presence' | 'tripwire' | 'dwell'
    direction: text("direction"), // 'in' | 'out' | 'both' (tripwire only)
    dwellSeconds: integer("dwell_seconds"), // dwell only
```

- [ ] **Step 2: Migrate**

Run: `cd backend && DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun run db:push`
Expected: drizzle-kit adds `zones.kind`, `rules.type`, `rules.direction`, `rules.dwell_seconds`. (Start `docker compose up -d postgres` first if needed. These are all new columns with defaults — non-destructive.)

- [ ] **Step 3: Typecheck + commit**

Run: `cd backend && bunx tsc --noEmit` → no errors.

```bash
git add backend/src/db/schema.ts
git commit -m "feat(db): zone kind + rule type/direction/dwellSeconds columns"
```

---

### Task 2: Zone `kind` validation (line vs polygon)

**Files:**
- Modify: `backend/src/rules/routes.ts` (zone POST/PATCH)
- Modify: `backend/test/rules.test.ts`

**Interfaces:**
- Consumes: `zones.kind` (Task 1).
- Produces: zones POST/PATCH accept `kind` (`polygon` default | `line`) and validate the point count for the kind (`line` = exactly 2 points in [0,1]; `polygon` = ≥3). Zone rows carry `kind`.

- [ ] **Step 1: Write the failing tests**

Add to `backend/test/rules.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify fail**

Run: `cd backend && DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun test test/rules.test.ts`
Expected: FAIL — `kind` ignored, a 2-point polygon is rejected by the current `>=3` check (line create returns 400).

- [ ] **Step 3: Implement kind-aware validation**

In `backend/src/rules/routes.ts`, replace `validPolygon` with a kind-aware validator and use it in POST/PATCH:

```ts
function pointsInRange(p: unknown): p is { x: number; y: number }[] {
  return (
    Array.isArray(p) &&
    p.every(
      (pt: any) =>
        pt && typeof pt.x === "number" && typeof pt.y === "number" &&
        pt.x >= 0 && pt.x <= 1 && pt.y >= 0 && pt.y <= 1,
    )
  );
}
// A polygon needs >=3 points; a line needs exactly 2.
function validGeometry(kind: string, p: unknown): string | null {
  if (!pointsInRange(p)) return "points must be in [0,1]";
  const pts = p as { x: number; y: number }[];
  if (kind === "line") return pts.length === 2 ? null : "a line needs exactly 2 points";
  return pts.length >= 3 ? null : "a polygon needs >=3 points";
}
```

In `zoneRoutes.post`:

```ts
  const name = b?.name?.trim();
  if (!name) return c.json({ error: "name required" }, 400);
  const kind = b?.kind === "line" ? "line" : "polygon";
  const gErr = validGeometry(kind, b?.polygon);
  if (gErr) return c.json({ error: gErr }, 400);
  const [zone] = await db.insert(zones).values({ cameraId: cam.id, name, kind, polygon: b.polygon }).returning();
```

In `zoneRoutes.patch`, replace the polygon block so a polygon update is validated against the zone's kind (patch can also change `kind`):

```ts
  const b = await c.req.json().catch(() => ({}));
  const patch: Record<string, unknown> = {};
  if (typeof b.name === "string") patch.name = b.name.trim();
  if (b.kind === "line" || b.kind === "polygon") patch.kind = b.kind;
  if (b.polygon !== undefined) {
    // validate against the new kind if provided, else the existing row's kind
    const [existing] = await db.select({ kind: zones.kind }).from(zones).where(and(eq(zones.id, c.req.param("zoneId")), eq(zones.cameraId, cam.id))).limit(1);
    if (!existing) return c.json({ error: "not found" }, 404);
    const kind = (patch.kind as string) ?? existing.kind;
    const gErr = validGeometry(kind, b.polygon);
    if (gErr) return c.json({ error: gErr }, 400);
    patch.polygon = b.polygon;
  }
  if (Object.keys(patch).length === 0) return c.json({ error: "nothing to update" }, 400);
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun test test/rules.test.ts`
Expected: PASS (existing polygon tests still pass; new line tests pass).

- [ ] **Step 5: Commit**

```bash
git add backend/src/rules/routes.ts backend/test/rules.test.ts
git commit -m "feat(api): line-kind zones (2-point) + kind-aware geometry validation"
```

---

### Task 3: Rule type validation + resolveRules tracking fields

**Files:**
- Modify: `backend/src/rules/routes.ts` (rule POST/PATCH validation + `ResolvedRule`/`resolveRules`)
- Modify: `backend/test/rules.test.ts`

**Interfaces:**
- Consumes: `rules.type/direction/dwellSeconds`, `zones.kind` (Task 1).
- Produces: rule create/update validate `type ∈ {presence,tripwire,dwell}`, tripwire→line-zone+direction, dwell→polygon-zone+dwellSeconds>0; `ResolvedRule` gains `type`, `direction`, `dwell_seconds`; `resolveRules` returns them.

- [ ] **Step 1: Write the failing tests**

Add to `backend/test/rules.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify fail**

Run: `cd backend && DATABASE_URL=... bun test test/rules.test.ts` → new tests FAIL (type ignored; resolveRules has no `type`).

- [ ] **Step 3: Implement type validation + a zone-kind helper**

In `backend/src/rules/routes.ts`:

1. Add near the other constants:

```ts
const RULE_TYPES = ["presence", "tripwire", "dwell"];
const DIRECTIONS = ["in", "out", "both"];

async function zoneKind(cameraId: string, zoneId: string): Promise<string | null> {
  const [z] = await db.select({ kind: zones.kind }).from(zones).where(and(eq(zones.id, zoneId), eq(zones.cameraId, cameraId))).limit(1);
  return z?.kind ?? null;
}
```

2. Add a type-aware check used by POST and PATCH after the class/severity validation. Insert this async helper:

```ts
// Validate the type-specific requirements. Returns an error string or null.
async function validateRuleType(cameraId: string, b: any): Promise<string | null> {
  const type = b.type ?? "presence";
  if (!RULE_TYPES.includes(type)) return "type must be presence|tripwire|dwell";
  if (type === "tripwire") {
    if (!b.zoneId) return "tripwire needs a line zone";
    if (await zoneKind(cameraId, b.zoneId) !== "line") return "tripwire needs a line-kind zone";
    if (!DIRECTIONS.includes(b.direction)) return "tripwire needs direction in|out|both";
  } else if (type === "dwell") {
    if (!b.zoneId) return "dwell needs a polygon zone";
    if (await zoneKind(cameraId, b.zoneId) !== "polygon") return "dwell needs a polygon-kind zone";
    if (typeof b.dwellSeconds !== "number" || b.dwellSeconds <= 0) return "dwell needs dwellSeconds > 0";
  }
  return null;
}
```

3. In `ruleRoutes.post`, after the existing `zoneBelongs` check, add:

```ts
  const tErr = await validateRuleType(cam.id, b);
  if (tErr) return c.json({ error: tErr }, 400);
```
and include the new fields in the insert `.values({...})`:

```ts
    type: b.type ?? "presence",
    direction: b.direction ?? null,
    dwellSeconds: typeof b.dwellSeconds === "number" ? b.dwellSeconds : null,
```

4. In `ruleRoutes.patch`, after the `zoneBelongs` check, validate the merged type (fetch current row for fields not in the patch). Add:

```ts
  const [cur] = await db.select().from(rules).where(and(eq(rules.id, c.req.param("ruleId")), eq(rules.cameraId, cam.id))).limit(1);
  if (!cur) return c.json({ error: "not found" }, 404);
  const effective = { type: b.type ?? cur.type, zoneId: b.zoneId ?? cur.zoneId, direction: b.direction ?? cur.direction, dwellSeconds: b.dwellSeconds ?? cur.dwellSeconds };
  const tErr = await validateRuleType(cam.id, effective);
  if (tErr) return c.json({ error: tErr }, 400);
```
and add `type`, `direction`, `dwellSeconds` to the patch field-copy loop's key list:

```ts
  for (const k of ["name", "classes", "zoneId", "scheduleStart", "scheduleEnd", "minConfidence", "severity", "enabled", "type", "direction", "dwellSeconds"]) {
```

5. Extend `ResolvedRule` + `resolveRules`:

```ts
export type ResolvedRule = {
  id: string;
  type: string;
  classes: string[];
  zone: { x: number; y: number }[] | null;
  direction: string | null;
  dwell_seconds: number | null;
  schedule: [string | null, string | null];
  min_confidence: number;
  severity: string;
  enabled: boolean;
};
```
In `resolveRules`'s `.map`, add:

```ts
    type: r.type,
    direction: r.direction,
    dwell_seconds: r.dwellSeconds,
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && DATABASE_URL=... bun test test/rules.test.ts` → PASS. Then `bunx tsc --noEmit` clean, and full `bun test` green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/rules/routes.ts backend/test/rules.test.ts
git commit -m "feat(api): tripwire/dwell rule validation + resolveRules tracking fields"
```

---

### Task 4: Worker tracker (`supervision` ByteTrack behind an interface)

**Files:**
- Modify: `worker/requirements.txt` (add `supervision`)
- Create: `worker/app/tracker.py`

**Interfaces:**
- Consumes: `Box` (from `detector.py`), `COCO_NAMES`/`_NAME_TO_ID`.
- Produces: `Track` dataclass `(id:int, x,y,w,h:float, conf:float, label:str)`; `Tracker` ABC with `update(boxes, frame_w, frame_h) -> list[Track]`; `ByteTrackTracker(Tracker)` wrapping `supervision.ByteTrack`, one instance per camera. Heavy imports (`supervision`, `numpy`) local to `ByteTrackTracker` — NOT unit-tested on the host (Docker-only, verified at e2e), like `recorder_io.py`.

- [ ] **Step 1: Add the dependency**

Append to `worker/requirements.txt`:

```
supervision==0.22.0
```

- [ ] **Step 2: Implement the tracker**

Create `worker/app/tracker.py`:

```python
from abc import ABC, abstractmethod
from dataclasses import dataclass

from .detector import Box, COCO_NAMES, _NAME_TO_ID


@dataclass
class Track:
    id: int
    x: float
    y: float
    w: float
    h: float
    conf: float
    label: str


class Tracker(ABC):
    @abstractmethod
    def update(self, boxes: list[Box], frame_w: int, frame_h: int) -> list[Track]:
        ...


class ByteTrackTracker(Tracker):
    """Standalone ByteTrack (supervision), one instance per camera. Feeds it plain
    detections (pixel xyxy + conf + class id), reads back tracker_id. Heavy import
    kept local so the pure tracking-rules tests don't need supervision/numpy."""

    def __init__(self, bytetrack=None):
        if bytetrack is None:
            import supervision as sv

            bytetrack = sv.ByteTrack()
        self._bt = bytetrack

    def update(self, boxes: list[Box], frame_w: int, frame_h: int) -> list[Track]:
        import numpy as np
        import supervision as sv

        if not boxes:
            # advance the tracker with an empty frame so it ages tracks correctly
            self._bt.update_with_detections(sv.Detections.empty())
            return []

        xyxy = np.array(
            [[b.x * frame_w, b.y * frame_h, (b.x + b.w) * frame_w, (b.y + b.h) * frame_h] for b in boxes],
            dtype=float,
        )
        conf = np.array([b.conf for b in boxes], dtype=float)
        cls = np.array([_NAME_TO_ID.get(b.label, -1) for b in boxes], dtype=int)
        det = sv.Detections(xyxy=xyxy, confidence=conf, class_id=cls)
        det = self._bt.update_with_detections(det)

        tracks: list[Track] = []
        for i in range(len(det)):
            tid = det.tracker_id[i]
            if tid is None:
                continue
            x1, y1, x2, y2 = det.xyxy[i]
            cid = int(det.class_id[i]) if det.class_id is not None else -1
            tracks.append(
                Track(
                    id=int(tid),
                    x=x1 / frame_w,
                    y=y1 / frame_h,
                    w=(x2 - x1) / frame_w,
                    h=(y2 - y1) / frame_h,
                    conf=round(float(det.confidence[i]), 4) if det.confidence is not None else 0.0,
                    label=COCO_NAMES.get(cid, str(cid)),
                )
            )
        return tracks
```

- [ ] **Step 3: Verify (deps absent on host — syntax only)**

Run: `cd worker && python3 -m py_compile app/tracker.py && echo OK`
Expected: OK. (Do NOT import it — `supervision`/`numpy` are Docker-only; runtime is verified at Task 9's e2e.)
Run: `cd worker && python3 -m unittest discover -s tests -v` → the existing pure suite still passes (nothing imports `tracker.py` yet).

- [ ] **Step 4: Commit**

```bash
git add worker/requirements.txt worker/app/tracker.py
git commit -m "feat(worker): per-camera ByteTrack tracker behind a Tracker interface"
```

---

### Task 5: Tracking-rules evaluation (`tracking_rules.py`) — pure, TDD

**Files:**
- Create: `worker/app/tracking_rules.py`
- Create: `worker/tests/test_tracking_rules.py`

**Interfaces:**
- Consumes: `Match`, `point_in_polygon`, `schedule_active` from `rules.py` (M2a).
- Produces: `bottom_center(o) -> (x,y)`; `segment_crosses(prev, cur, line, direction) -> bool`; `DwellState`; `evaluate_tracking(tracks, rules, state, last_center, now_s, now_hhmm, default_conf) -> list[Match]`. A *track* is duck-typed: `.id .x .y .w .h .conf .label`.

- [ ] **Step 1: Write the failing tests**

Create `worker/tests/test_tracking_rules.py`:

```python
import unittest

from app.tracking_rules import segment_crosses, evaluate_tracking, DwellState


class T:
    def __init__(self, id, x, y, w, h, conf=0.9, label="person"):
        self.id, self.x, self.y, self.w, self.h, self.conf, self.label = id, x, y, w, h, conf, label


# vertical line down the middle, A=top B=bottom
VLINE = [{"x": 0.5, "y": 0.2}, {"x": 0.5, "y": 0.8}]


class TestCrossing(unittest.TestCase):
    def test_crosses_both(self):
        self.assertTrue(segment_crosses((0.4, 0.5), (0.6, 0.5), VLINE, "both"))

    def test_no_cross_same_side(self):
        self.assertFalse(segment_crosses((0.3, 0.5), (0.45, 0.5), VLINE, "both"))

    def test_no_cross_when_missing_the_segment_extent(self):
        # crosses the infinite line's x but well below the segment (y=0.95 > 0.8)
        self.assertFalse(segment_crosses((0.4, 0.95), (0.6, 0.95), VLINE, "both"))

    def test_direction_in_vs_out(self):
        left_to_right = ((0.4, 0.5), (0.6, 0.5))
        right_to_left = ((0.6, 0.5), (0.4, 0.5))
        # exactly one of in/out fires for a given crossing direction, and they swap
        self.assertNotEqual(
            segment_crosses(*left_to_right, VLINE, "in"),
            segment_crosses(*left_to_right, VLINE, "out"),
        )
        self.assertEqual(
            segment_crosses(*left_to_right, VLINE, "in"),
            segment_crosses(*right_to_left, VLINE, "out"),
        )


def rule(**kw):
    base = {"id": "r", "type": "tripwire", "classes": ["person"], "zone": VLINE,
            "direction": "both", "dwell_seconds": None, "schedule": [None, None],
            "min_confidence": 0.4, "severity": "high", "enabled": True}
    base.update(kw)
    return base


class TestEvaluateTracking(unittest.TestCase):
    def test_tripwire_fires_on_crossing(self):
        state, last = {}, {1: (0.4, 0.6)}  # prev center left of line
        tracks = [T(1, 0.55, 0.5, 0.1, 0.1)]  # bottom-center (0.6, 0.6) right of line
        m = evaluate_tracking(tracks, [rule()], state, last, 0.0, "12:00", 0.4)
        self.assertEqual(len(m), 1)
        self.assertEqual(m[0].rule_id, "r")

    def test_tripwire_needs_two_positions(self):
        state, last = {}, {}  # no prev center -> can't test a crossing
        tracks = [T(1, 0.55, 0.5, 0.1, 0.1)]
        self.assertEqual(evaluate_tracking(tracks, [rule()], state, last, 0.0, "12:00", 0.4), [])

    def test_dwell_fires_once_at_threshold_then_not_again(self):
        POLY = [{"x": 0.0, "y": 0.0}, {"x": 1.0, "y": 0.0}, {"x": 1.0, "y": 1.0}, {"x": 0.0, "y": 1.0}]
        dr = rule(type="dwell", zone=POLY, direction=None, dwell_seconds=5)
        state, last = {}, {}
        tr = [T(1, 0.4, 0.4, 0.1, 0.1)]  # inside
        # t=0 enters, not yet 5s -> no fire
        self.assertEqual(evaluate_tracking(tr, [dr], state, last, 0.0, "12:00", 0.4), [])
        # t=5 -> fires once
        self.assertEqual(len(evaluate_tracking(tr, [dr], state, last, 5.0, "12:00", 0.4)), 1)
        # t=6 -> already fired, no repeat
        self.assertEqual(evaluate_tracking(tr, [dr], state, last, 6.0, "12:00", 0.4), [])

    def test_dwell_resets_on_leave_and_reentry(self):
        POLY = [{"x": 0.0, "y": 0.0}, {"x": 0.5, "y": 0.0}, {"x": 0.5, "y": 0.5}, {"x": 0.0, "y": 0.5}]
        dr = rule(type="dwell", zone=POLY, direction=None, dwell_seconds=5)
        state, last = {}, {}
        inside = [T(1, 0.1, 0.1, 0.05, 0.05)]      # bottom-center (0.125, 0.15) inside
        outside = [T(1, 0.8, 0.8, 0.05, 0.05)]     # outside
        evaluate_tracking(inside, [dr], state, last, 0.0, "12:00", 0.4)
        evaluate_tracking(inside, [dr], state, last, 5.0, "12:00", 0.4)  # fires
        evaluate_tracking(outside, [dr], state, last, 6.0, "12:00", 0.4)  # leaves -> reset
        # re-enters, must dwell a fresh 5s from t=6, so t=7 no fire, t=11 fires again
        self.assertEqual(evaluate_tracking(inside, [dr], state, last, 7.0, "12:00", 0.4), [])
        self.assertEqual(len(evaluate_tracking(inside, [dr], state, last, 11.0, "12:00", 0.4)), 1)

    def test_class_and_conf_and_schedule_filter(self):
        state, last = {}, {1: (0.4, 0.6)}
        car = [T(1, 0.55, 0.5, 0.1, 0.1, label="car")]
        # rule only watches person -> no match
        self.assertEqual(evaluate_tracking(car, [rule()], state, last, 0.0, "12:00", 0.4), [])
        # schedule inactive -> no match even for a person crossing
        person = [T(1, 0.55, 0.5, 0.1, 0.1)]
        self.assertEqual(evaluate_tracking(person, [rule(schedule=["22:00", "06:00"])], state, last, 0.0, "12:00", 0.4), [])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to verify fail**

Run: `cd worker && python3 -m unittest tests.test_tracking_rules -v`
Expected: FAIL — `No module named 'app.tracking_rules'`.

- [ ] **Step 3: Implement `tracking_rules.py`**

Create `worker/app/tracking_rules.py`:

```python
from .rules import Match, point_in_polygon, schedule_active


def bottom_center(o):
    return (o.x + o.w / 2.0, o.y + o.h)


def _side(a, b, p):
    """Signed side of point p relative to the directed line a->b (cross product)."""
    return (b["x"] - a["x"]) * (p[1] - a["y"]) - (b["y"] - a["y"]) * (p[0] - a["x"])


def _ccw(ax, ay, bx, by, cx, cy):
    return (cy - ay) * (bx - ax) - (by - ay) * (cx - ax)


def _segments_intersect(p1, p2, p3, p4):
    d1 = _ccw(p3[0], p3[1], p4[0], p4[1], p1[0], p1[1])
    d2 = _ccw(p3[0], p3[1], p4[0], p4[1], p2[0], p2[1])
    d3 = _ccw(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1])
    d4 = _ccw(p1[0], p1[1], p2[0], p2[1], p4[0], p4[1])
    return ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0))


def segment_crosses(prev, cur, line, direction) -> bool:
    """True if the prev->cur segment crosses the line segment (line = [A, B] with
    {"x","y"}) in the requested sense. `both` = either way; `in` = the object's
    signed side goes from + to - across A->B; `out` = the reverse."""
    a, b = line[0], line[1]
    if not _segments_intersect(prev, cur, (a["x"], a["y"]), (b["x"], b["y"])):
        return False
    if direction == "both" or direction is None:
        return True
    s_prev = _side(a, b, prev)
    s_cur = _side(a, b, cur)
    if direction == "in":
        return s_prev > 0 and s_cur < 0
    if direction == "out":
        return s_prev < 0 and s_cur > 0
    return False


class DwellState:
    def __init__(self):
        self.entered_at = None
        self.fired = False


def evaluate_tracking(tracks, rules, state, last_center, now_s, now_hhmm, default_conf):
    """Matches for tripwire/dwell rules. `state` is a dict keyed (rule_id, track_id)
    of DwellState (mutated in place); `last_center` maps track_id -> previous
    bottom-center (the caller updates it after this returns)."""
    matches = []
    for rule in rules:
        if not rule.get("enabled", True):
            continue
        s, e = rule.get("schedule", [None, None])
        if not schedule_active(s, e, now_hhmm):
            continue
        min_conf = rule.get("min_confidence") or default_conf
        classes = rule["classes"]
        rid = rule["id"]
        sev = rule["severity"]
        sel = [t for t in tracks if t.label in classes and t.conf >= min_conf]
        typ = rule["type"]

        if typ == "tripwire":
            line = rule["zone"]
            direction = rule.get("direction", "both")
            for t in sel:
                prev = last_center.get(t.id)
                if prev is None:
                    continue
                if segment_crosses(prev, bottom_center(t), line, direction):
                    matches.append(Match(rid, sev, t.label, [t], 1, t.conf))

        elif typ == "dwell":
            zone = rule["zone"]
            dwell = rule.get("dwell_seconds") or 0
            present = set()
            for t in sel:
                cx, cy = bottom_center(t)
                if point_in_polygon(cx, cy, zone):
                    present.add(t.id)
                    st = state.setdefault((rid, t.id), DwellState())
                    if st.entered_at is None:
                        st.entered_at = now_s
                    if not st.fired and now_s - st.entered_at >= dwell:
                        st.fired = True
                        matches.append(Match(rid, sev, t.label, [t], 1, t.conf))
            # a track no longer inside this rule's zone -> reset its dwell episode
            for key in [k for k in state if k[0] == rid and k[1] not in present]:
                del state[key]
    return matches
```

- [ ] **Step 4: Run to verify pass**

Run: `cd worker && python3 -m unittest tests.test_tracking_rules -v`
Expected: PASS (all crossing/dwell tests). Then the full pure suite: `cd worker && python3 -m unittest discover -s tests -v` → all green.

- [ ] **Step 5: Commit**

```bash
git add worker/app/tracking_rules.py worker/tests/test_tracking_rules.py
git commit -m "feat(worker): tracking-rules evaluation (tripwire crossing + dwell)"
```

---

### Task 6: Wire the tracker + tracking rules into the camera pipeline

**Files:**
- Modify: `worker/app/camera_worker.py`
- Modify: `docs/EVENT_FORMAT.md`

**Interfaces:**
- Consumes: `ByteTrackTracker` (Task 4), `evaluate_tracking` (Task 5), `evaluate` (M2a).
- Produces: `CameraWorker` runs a per-camera tracker, splits rules by `type`, evaluates presence (M2a) + tracking, emits per-match (tracking bypasses dedup), keeps dwell/last-center state.

- [ ] **Step 1: Imports, tracker + state in `__init__`, clear state on `set_rules`**

In `worker/app/camera_worker.py`:
1. Add imports:
```python
from .rules import evaluate as evaluate_rules
from .tracking_rules import evaluate_tracking, bottom_center
from .tracker import ByteTrackTracker
```
2. In `__init__`, after `self.recorder = Recorder(...)`, add:
```python
        self.tracker = ByteTrackTracker()
        self._dwell_state: dict = {}
        self._last_center: dict = {}
```
3. Update `set_rules` to clear tracking state when rules change:
```python
    def set_rules(self, rules) -> None:
        self.rules = rules or []
        self._dwell_state = {}
        self._last_center = {}
```

- [ ] **Step 2: Detect + track in the decode loop**

In `_decode_loop`, replace the detection block:
```python
                    boxes = []
                    if frame_count % DETECT_EVERY_N == 0:
                        boxes = self.detector.detect_objects(img)

                    annotated = self._annotate(img, boxes)
                    if boxes:
                        self._emit_matches(img, boxes, now, annotated)
```
with:
```python
                    boxes = []
                    tracks = []
                    if frame_count % DETECT_EVERY_N == 0:
                        boxes = self.detector.detect_objects(img)
                        if boxes:
                            tracks = self.tracker.update(boxes, img.shape[1], img.shape[0])

                    annotated = self._annotate(img, boxes)
                    if boxes:
                        self._emit_matches(img, boxes, tracks, now, annotated)
```

- [ ] **Step 3: Rewrite `_emit_matches` to split presence vs tracking**

Replace `_emit_matches` with:
```python
    def _emit_one(self, m, w, h) -> str:
        payload = detection_event(
            self.camera_id, m.confidence, m.count,
            [
                {"x": round(b.x, 4), "y": round(b.y, 4), "w": round(b.w, 4),
                 "h": round(b.h, 4), "conf": b.conf, "label": b.label}
                for b in m.boxes
            ],
            w, h, WORKER_ID,
            label=m.label, rule_id=m.rule_id, severity=m.severity,
        )
        self._evq.put(("detections", payload))
        return payload["id"]

    def _emit_matches(self, img, boxes, tracks, now_ms: float, annotated) -> None:
        now_hhmm = self._now_hhmm()
        presence_rules = [r for r in self.rules if r.get("type", "presence") == "presence"]
        tracking_rules = [r for r in self.rules if r.get("type", "presence") in ("tripwire", "dwell")]

        # implicit "any person, low" default only when the camera has NO rules at all
        if not self.rules:
            presence_matches = evaluate_rules(boxes, [], now_hhmm, CONF_THRESHOLD)
        elif presence_rules:
            presence_matches = evaluate_rules(boxes, presence_rules, now_hhmm, CONF_THRESHOLD)
        else:
            presence_matches = []

        tracking_matches = (
            evaluate_tracking(tracks, tracking_rules, self._dwell_state, self._last_center,
                              now_ms / 1000.0, now_hhmm, CONF_THRESHOLD)
            if tracking_rules else []
        )
        # remember this frame's centers for the next frame's crossing test
        if tracks:
            self._last_center = {t.id: bottom_center(t) for t in tracks}

        if not presence_matches and not tracking_matches:
            return
        self._det_times.append(now_ms)
        h, w = img.shape[:2]
        first_emitted_id = None

        # presence: keep the M2a per-(camera,rule) count dedup
        for m in presence_matches:
            key = f"{self.camera_id}:{m.rule_id or ''}"
            if not self.limiter.should_emit(key, m.count, now_ms):
                continue
            eid = self._emit_one(m, w, h)
            first_emitted_id = first_emitted_id or eid

        # tracking: bypass the count dedup (episodic, self-limiting)
        for m in tracking_matches:
            eid = self._emit_one(m, w, h)
            first_emitted_id = first_emitted_id or eid

        if first_emitted_id is not None:
            self.recorder.trigger(annotated, first_emitted_id)
```

- [ ] **Step 4: Document the new rule fields in EVENT_FORMAT.md**

In `docs/EVENT_FORMAT.md` §1, note that each rule in the `start`/`rules_update` `rules` array may carry `type` (`presence|tripwire|dwell`), `direction` (`in|out|both`, tripwire), and `dwell_seconds` (dwell), and that a tripwire's `zone` is a 2-point line. The detection event is unchanged.

- [ ] **Step 5: Verify (heavy deps Docker-only)**

Run: `cd worker && python3 -m py_compile app/camera_worker.py && echo OK`
Run: `cd worker && python3 -m unittest discover -s tests -v` → all pure tests pass (none import camera_worker). Real runtime is Task 9's e2e.

- [ ] **Step 6: Commit**

```bash
git add worker/app/camera_worker.py docs/EVENT_FORMAT.md
git commit -m "feat(worker): per-camera tracking + tripwire/dwell evaluation in the pipeline"
```

---

### Task 7: Frontend types (zone kind + rule type fields)

**Files:**
- Modify: `frontend/lib/types.ts`

**Interfaces:**
- Produces: `Zone.kind`; `Rule.type/direction/dwellSeconds`; `ZoneKind`/`RuleType` unions.

- [ ] **Step 1: Add the types**

In `frontend/lib/types.ts`:
1. Add unions near `Severity`:
```ts
export type ZoneKind = "polygon" | "line";
export type RuleType = "presence" | "tripwire" | "dwell";
export type Direction = "in" | "out" | "both";
```
2. Add `kind` to `Zone`:
```ts
  kind: ZoneKind;
```
3. Add to `Rule`:
```ts
  type: RuleType;
  direction: Direction | null;
  dwellSeconds: number | null;
```

- [ ] **Step 2: Build**

Run: `cd frontend && npm run build`
Expected: compiles (additive; existing consumers still valid — `kind` is now required on `Zone`, and both `Zone` producers are `api.listZones` responses which now include it).

- [ ] **Step 3: Commit**

```bash
git add frontend/lib/types.ts
git commit -m "feat(web): zone kind + rule type/direction/dwellSeconds types"
```

---

### Task 8: Zone editor — line mode + direction arrow

**Files:**
- Modify: `frontend/components/ZoneEditor.tsx`
- Modify: `frontend/app/globals.css`

**Interfaces:**
- Consumes: `api.createZone` (passes `kind`), `Zone.kind`.
- Produces: a **polygon | line** mode toggle; line mode = click exactly 2 points, render with a direction arrow; save with `kind`.

- [ ] **Step 1: Add a mode + kind-aware draw/save**

Replace `frontend/components/ZoneEditor.tsx` with:

```tsx
"use client";
import { useEffect, useRef, useState } from "react";
import type { Camera, Zone } from "@/lib/types";
import { api } from "@/lib/api";
import { toNormalized, toPixels, type Pt } from "@/lib/geometry";

const W = 640, H = 360;

export function ZoneEditor({ camera, videoEl, onClose }: { camera: Camera; videoEl: HTMLVideoElement | null; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zones, setZones] = useState<Zone[]>([]);
  const [points, setPoints] = useState<Pt[]>([]);
  const [name, setName] = useState("Zone");
  const [mode, setMode] = useState<"polygon" | "line">("polygon");
  const [snapshot, setSnapshot] = useState<ImageData | null>(null);
  const live = !!videoEl && videoEl.videoWidth > 0;
  const need = mode === "line" ? 2 : 3;

  useEffect(() => { api.listZones(camera.id).then(setZones).catch(() => {}); }, [camera.id]);

  useEffect(() => {
    if (!videoEl || !live) return;
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(videoEl, 0, 0, W, H);
    setSnapshot(ctx.getImageData(0, 0, W, H));
  }, [videoEl, live]);

  useEffect(() => {
    const c = canvasRef.current; if (!c) return;
    const ctx = c.getContext("2d")!;
    if (snapshot) ctx.putImageData(snapshot, 0, 0);
    else { ctx.fillStyle = "#222"; ctx.fillRect(0, 0, W, H); }
    for (const z of zones) {
      const px = toPixels(z.polygon as Pt[], W, H);
      if (z.kind === "line") drawLine(ctx, px, "rgba(255,180,0,0.8)");
      else drawPoly(ctx, px, "rgba(0,180,255,0.6)");
    }
    if (points.length) {
      if (mode === "line") drawLine(ctx, points, "rgba(0,255,0,0.9)");
      else drawPoly(ctx, points, "rgba(0,255,0,0.9)", true);
    }
  }, [snapshot, zones, points, mode]);

  function drawPoly(ctx: CanvasRenderingContext2D, pts: Pt[], color: string, open = false) {
    if (!pts.length) return;
    ctx.strokeStyle = color; ctx.fillStyle = color.replace(/[\d.]+\)$/, "0.15)"); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    pts.forEach((p) => ctx.lineTo(p.x, p.y));
    if (!open) ctx.closePath();
    ctx.stroke(); if (!open) ctx.fill();
    pts.forEach((p) => { ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, 7); ctx.fill(); });
  }
  // draw a segment A->B with an arrowhead at B (the direction reference)
  function drawLine(ctx: CanvasRenderingContext2D, pts: Pt[], color: string) {
    if (pts.length < 2) { if (pts[0]) { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(pts[0].x, pts[0].y, 3, 0, 7); ctx.fill(); } return; }
    const [a, b] = pts;
    ctx.strokeStyle = color; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    ctx.beginPath(); ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - 10 * Math.cos(ang - 0.4), b.y - 10 * Math.sin(ang - 0.4));
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - 10 * Math.cos(ang + 0.4), b.y - 10 * Math.sin(ang + 0.4));
    ctx.stroke();
  }

  function addPoint(e: React.MouseEvent) {
    const r = canvasRef.current!.getBoundingClientRect();
    const p = { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
    setPoints((prev) => (mode === "line" ? [...prev, p].slice(-2) : [...prev, p]));
  }

  async function save() {
    if (points.length < need) return;
    await api.createZone(camera.id, { name: name.trim() || "Zone", kind: mode, polygon: toNormalized(points, W, H) });
    setPoints([]); setZones(await api.listZones(camera.id));
  }
  async function del(id: string) { await api.deleteZone(camera.id, id); setZones(await api.listZones(camera.id)); }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="clip-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Zones — {camera.name}</h3>
        <div className="mode-toggle">
          <button className={mode === "polygon" ? "chip on" : "chip"} onClick={() => { setMode("polygon"); setPoints([]); }}>Polygon (area)</button>
          <button className={mode === "line" ? "chip on" : "chip"} onClick={() => { setMode("line"); setPoints([]); }}>Line (tripwire)</button>
        </div>
        {!live && <p className="muted small">Start the camera to draw zones on the live view.</p>}
        {mode === "line" && <p className="muted small">Click 2 points. The arrow shows the line's A→B direction (used by tripwire in/out).</p>}
        <canvas ref={canvasRef} width={W} height={H} onClick={addPoint} style={{ width: "100%", cursor: "crosshair", background: "#111" }} />
        <div className="modal-actions">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Zone name" />
          <button onClick={() => setPoints([])}>Clear</button>
          <button className="primary" onClick={save} disabled={points.length < need}>Save {mode} ({points.length})</button>
          <button onClick={onClose}>Close</button>
        </div>
        <div className="zone-list">
          {zones.map((z) => (
            <div key={z.id} className="zone-row"><span>{z.name} <span className="muted small">({z.kind})</span></span><button className="danger" onClick={() => del(z.id)}>Delete</button></div>
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Style the mode toggle**

Append to `frontend/app/globals.css`:
```css
.mode-toggle { display: flex; gap: 6px; margin-bottom: 6px; }
```

- [ ] **Step 3: Build**

Run: `cd frontend && npm run build`
Expected: compiles.

- [ ] **Step 4: Commit**

```bash
git add frontend/components/ZoneEditor.tsx frontend/app/globals.css
git commit -m "feat(web): zone editor line mode + direction arrow"
```

---

### Task 9: Rules panel — type selector + tripwire/dwell config

**Files:**
- Modify: `frontend/components/RulesPanel.tsx`

**Interfaces:**
- Consumes: `api.createRule` (passes `type/direction/dwellSeconds`), `Zone.kind`, `Rule.type`.
- Produces: a rule-**type** selector; tripwire → line-zone dropdown + direction; dwell → polygon-zone dropdown + dwell-seconds; presence → unchanged. Zone dropdown filtered by the kind the type needs.

- [ ] **Step 1: Add type-aware form**

Replace `frontend/components/RulesPanel.tsx` with:

```tsx
"use client";
import { useEffect, useState } from "react";
import type { Camera, Rule, Zone } from "@/lib/types";
import { api } from "@/lib/api";

const CLASSES = ["person", "bicycle", "car", "motorcycle", "bus", "truck", "cat", "dog", "backpack", "handbag", "suitcase"];
const empty = { name: "", type: "presence", classes: ["person"] as string[], zoneId: "", direction: "both", dwellSeconds: 10, scheduleStart: "", scheduleEnd: "", minConfidence: 0.4, severity: "low", enabled: true };

export function RulesPanel({ camera, onClose }: { camera: Camera; onClose: () => void }) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [form, setForm] = useState<any>(empty);
  const [err, setErr] = useState<string | null>(null);

  const load = () => { api.listRules(camera.id).then(setRules).catch(() => {}); };
  useEffect(() => { load(); api.listZones(camera.id).then(setZones).catch(() => {}); }, [camera.id]);

  const lineZones = zones.filter((z) => z.kind === "line");
  const polyZones = zones.filter((z) => z.kind === "polygon");

  async function save() {
    setErr(null);
    try {
      const body: Record<string, unknown> = {
        name: form.name, type: form.type, classes: form.classes,
        scheduleStart: form.scheduleStart || null, scheduleEnd: form.scheduleEnd || null,
        minConfidence: Number(form.minConfidence), severity: form.severity, enabled: form.enabled,
      };
      if (form.type === "tripwire") { body.zoneId = form.zoneId || undefined; body.direction = form.direction; }
      else if (form.type === "dwell") { body.zoneId = form.zoneId || undefined; body.dwellSeconds = Number(form.dwellSeconds); }
      else { body.zoneId = form.zoneId || undefined; }
      await api.createRule(camera.id, body);
      setForm(empty); load();
    } catch (e: any) { setErr(e.message); }
  }
  async function toggle(r: Rule) { await api.updateRule(camera.id, r.id, { enabled: !r.enabled }); load(); }
  async function del(r: Rule) { await api.deleteRule(camera.id, r.id); load(); }
  function toggleClass(cl: string) { setForm((f: any) => ({ ...f, classes: f.classes.includes(cl) ? f.classes.filter((x: string) => x !== cl) : [...f.classes, cl] })); }
  // when the type changes, reset the zone selection (kinds differ)
  function setType(t: string) { setForm((f: any) => ({ ...f, type: t, zoneId: "" })); }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="clip-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Rules — {camera.name}</h3>
        <div className="rules-list">
          {rules.length === 0 && <p className="muted small">No rules — this camera alerts on any person (default).</p>}
          {rules.map((r) => (
            <div key={r.id} className="rule-row">
              <span className={`badge ${r.severity}`}>{r.severity}</span>
              <strong>{r.name}</strong>
              <span className="muted small">{r.type} · {(r.classes as string[]).join(", ")}{r.type === "tripwire" ? ` · ${r.direction}` : ""}{r.type === "dwell" ? ` · ${r.dwellSeconds}s` : ""}</span>
              <button onClick={() => toggle(r)}>{r.enabled ? "Disable" : "Enable"}</button>
              <button className="danger" onClick={() => del(r)}>Delete</button>
            </div>
          ))}
        </div>
        <hr />
        <div className="rule-form">
          <input placeholder="Rule name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <select value={form.type} onChange={(e) => setType(e.target.value)}>
            <option value="presence">presence (in area now)</option>
            <option value="tripwire">tripwire (cross a line)</option>
            <option value="dwell">dwell (loiter in area)</option>
          </select>
          <div className="class-chips">
            {CLASSES.map((cl) => (
              <button key={cl} className={form.classes.includes(cl) ? "chip on" : "chip"} onClick={() => toggleClass(cl)}>{cl}</button>
            ))}
          </div>
          {form.type === "presence" && (
            <select value={form.zoneId} onChange={(e) => setForm({ ...form, zoneId: e.target.value })}>
              <option value="">Whole frame</option>
              {polyZones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
            </select>
          )}
          {form.type === "tripwire" && (
            <>
              <select value={form.zoneId} onChange={(e) => setForm({ ...form, zoneId: e.target.value })}>
                <option value="">Pick a line…</option>
                {lineZones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
              </select>
              <select value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })}>
                <option value="both">both ways</option><option value="in">in (→)</option><option value="out">out (←)</option>
              </select>
            </>
          )}
          {form.type === "dwell" && (
            <>
              <select value={form.zoneId} onChange={(e) => setForm({ ...form, zoneId: e.target.value })}>
                <option value="">Pick an area…</option>
                {polyZones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
              </select>
              <label>Dwell secs <input type="number" min="1" step="1" value={form.dwellSeconds} onChange={(e) => setForm({ ...form, dwellSeconds: e.target.value })} /></label>
            </>
          )}
          <label>From <input type="time" value={form.scheduleStart} onChange={(e) => setForm({ ...form, scheduleStart: e.target.value })} /></label>
          <label>To <input type="time" value={form.scheduleEnd} onChange={(e) => setForm({ ...form, scheduleEnd: e.target.value })} /></label>
          <label>Min conf <input type="number" min="0" max="1" step="0.05" value={form.minConfidence} onChange={(e) => setForm({ ...form, minConfidence: e.target.value })} /></label>
          <select value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })}>
            <option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
          </select>
          {err && <p className="error">{err}</p>}
          <button className="primary" onClick={save} disabled={!form.name || form.classes.length === 0 || (form.type !== "presence" && !form.zoneId)}>Add rule</button>
        </div>
        <div className="modal-actions"><button onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Build**

Run: `cd frontend && npm run build`
Expected: compiles.

- [ ] **Step 3: Commit**

```bash
git add frontend/components/RulesPanel.tsx
git commit -m "feat(web): rules panel type selector + tripwire/dwell config"
```

---

### Task 10: End-to-end verification (docker) + docs

**Files:**
- Modify: `.env.example` / `README.md` (a one-line note that tripwire + dwell rules exist)

**Interfaces:** none (DoD smoke test).

- [ ] **Step 1: Docs note**

Add a one-line note to the README (near the M2a rules note) that rules support **tripwire** (line-crossing) and **dwell** (loiter) types, and that the worker uses ByteTrack (`supervision`) for tracking. Note the new worker dep in `.env`/README if a deps list exists.

- [ ] **Step 2: Full suites green**

Run: `cd backend && DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun test` → all pass.
Run: `cd worker && python3 -m unittest discover -s tests -v` → all pass (incl. `test_tracking_rules`).
Run: `cd frontend && npm run build` → compiles.

- [ ] **Step 3: End-to-end smoke (docker — first real tracker run)**

Run: `docker compose up -d --build backend worker mediamtx streamer`
(The worker image rebuild installs `supervision` — first build of that layer is slower.)
Then via the API (login demo/demo12345):
1. Start the seeded camera; confirm it still alerts (presence path intact).
2. Create a **line** zone across the walk path; add a `tripwire` rule (person, direction `both`); confirm a person walking through raises a **tripwire** alert tagged with the rule (`GET /alerts` shows the rule's severity + `label: person`).
3. Create a **polygon** zone; add a `dwell` rule (person, `dwellSeconds: 3`); confirm a person lingering ≥3s raises **one** dwell alert, and not again until they leave and return.
4. Confirm worker logs show no tracker exceptions; M1 clips still attach to the tracking alerts.
Expected: all of the above.

- [ ] **Step 4: Commit**

```bash
git add .env.example README.md
git commit -m "chore: document tripwire/dwell rules; M2b end-to-end verified"
```

---

## Self-Review

**Spec coverage** (against `docs/superpowers/specs/2026-07-13-m2b-tracking-rules-design.md`):
- Tracker = per-camera standalone ByteTrack behind interface → Task 4. ✔
- Rule types presence/tripwire/dwell + `rules.type` → Tasks 1, 3. ✔
- Line geometry = `zones.kind` (2-point line) → Tasks 1, 2. ✔
- Tripwire crossing (directional, ≥2 positions) + dwell (fire-once, reset/re-entry) → Task 5. ✔
- Track bottom-center; tracking bypasses count-dedup; implicit default only when zero rules → Tasks 5, 6. ✔
- resolveRules inlines type/direction/dwell_seconds → Task 3. ✔
- Backend validation (kind↔type pairing, direction, dwellSeconds) → Tasks 2, 3. ✔
- Frontend zone line mode + arrow, rules type selector + kind-filtered zone dropdown → Tasks 7, 8, 9. ✔
- EVENT_FORMAT doc → Task 6. ✔
- Backward compat (existing rows default presence/polygon) → Task 1 (column defaults). ✔
- Testing (pure crossing/dwell TDD; backend validation; frontend build) → Tasks 3, 5, 7–9. ✔
- e2e → Task 10. ✔

**Placeholder scan:** no TBD/TODO; every code step shows complete code.

**Type/name consistency:** `Track`/`ByteTrackTracker.update(boxes, w, h)` (Task 4) used in Task 6; `evaluate_tracking(tracks, rules, state, last_center, now_s, now_hhmm, default_conf)` + `bottom_center` (Task 5) called with that exact signature in Task 6; `Match` reused from `rules.py`; `ResolvedRule` fields `type/direction/dwell_seconds` (Task 3) consumed by the worker rule dicts (Task 5/6); `zones.kind`/`rules.type` column names consistent Tasks 1↔2↔3; frontend `Zone.kind`/`Rule.type` (Task 7) consumed in Tasks 8, 9.

**Known edges (documented):** the tracker + camera_worker are Docker-only (verified py_compile + e2e, not host-unit-tested — like `recorder_io.py`); dwell robustness depends on ByteTrack ID stability (a mid-episode ID swap resets the timer — acceptable per spec); a camera with only tracking rules has no presence default (intended).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-13-m2b-tracking-rules.md`.
