# M2b — Tracking Rules (tripwire + dwell)

**Date:** 2026-07-13
**Milestone:** M2b of the [OSS VMS roadmap](./2026-07-04-oss-vms-product-roadmap.md)
**Goal:** Add the two rule types that need object identity across frames —
**tripwire** (a tracked object crosses a line) and **dwell** (a tracked object
stays in a zone ≥ N seconds). Builds on the M2a rules engine by adding a
per-camera object tracker and two new rule types.

## Scope

**In:** per-camera object **tracking** (stable IDs across frames); `tripwire`
rule type (line-crossing, directional) and `dwell` rule type (loiter/dwell-time);
a `line`-kind zone (2 points) for tripwires; worker tracking evaluation; backend
schema/validation/delivery for the new rule fields; zone-editor line mode + rules
panel tripwire/dwell config.

**Out:** re-identification across cameras, appearance embeddings, path/heatmap
analytics, speed estimation, counting dashboards. (Future.)

## Decisions locked (from brainstorming)

- **Tracker = standalone ByteTrack** (`supervision.ByteTrack`), **one instance per
  `CameraWorker`**, behind a swappable `Tracker` interface. Chosen over
  `model.track()` because the shared YOLO model would bleed track IDs across
  cameras; a standalone tracker is per-camera and unit-testable (fed synthetic
  detections, not frames). **One new worker dependency: `supervision`.**
- **Rule types** via a new `rules.type` column: `presence` (default, = M2a) |
  `tripwire` | `dwell`.
- **Line geometry = a `line`-kind zone** (extend `zones.kind`), a 2-point zone.
  Reuses all existing zone CRUD / editor / `rules_update` plumbing.
- **Track reference point = box bottom-center** `(x + w/2, y + h)`, consistent
  with M2a's in-zone test.
- **Dwell fires once per episode:** alert the moment continuous time-in-zone first
  reaches `dwellSeconds`; state resets when the track leaves the zone or
  disappears; re-entry starts a new episode. (Not repeat-every-N.)
- **Tripwire fires once per crossing** (a crossing is a single frame-to-frame
  event); a track needs ≥2 observed positions to test a crossing.
- **Defaults:** `direction = both`, `dwellSeconds = 10`.

## Architecture

Fits the M2a shape. The **worker** gains a per-camera tracker. Each detect frame:
`detect_objects` → `tracker.update(boxes)` → `list[Track]` (id + box + label +
conf). **Presence** rules still evaluate on the raw boxes (M2a `evaluate`,
unchanged). **Tripwire/dwell** rules evaluate on the *tracks* plus a small
per-rule state kept on the `CameraWorker`. Every match emits the same detection
event (`rule_id`, `severity`, `label`) → alert, reusing all M2a delivery, dedup,
ack, and UI. The **API** stores the new rule fields and inlines them (with the
zone kind + points) in the rules pushed to the worker.

```
Worker (per CameraWorker)
  detect_objects(img) -> boxes[Box(x,y,w,h,conf,label)]
  tracker.update(boxes, w, h) -> tracks[Track(id, x,y,w,h, conf, label)]   # ByteTrack, per camera
  presence rules: evaluate(boxes, presence_rules, now_hhmm, conf)     # M2a, unchanged
  tracking rules: evaluate_tracking(tracks, tracking_rules, state, now_s, now_hhmm)
      tripwire: bottom-center prev->cur segment crosses the line in `direction`
      dwell:    bottom-center inside zone continuously >= dwellSeconds (fire once)
  -> Matches -> detection_event(label, rule_id, severity) -> Redis -> API -> alert
```

## Data model

### `zones` — add `kind`
```
kind  text not null default 'polygon'   -- 'polygon' | 'line'
```
`polygon` = existing (≥3 points). `line` = exactly 2 points `[start, end]` stored
in the same `polygon` jsonb column. No other zone changes.

### `rules` — add tracking columns
```
type          text not null default 'presence'   -- 'presence' | 'tripwire' | 'dwell'
direction     text                                -- 'in' | 'out' | 'both' (tripwire only)
dwellSeconds  integer                             -- dwell only, >0
```
Existing rows default to `type='presence'`, `direction=null`, `dwellSeconds=null`
— unchanged behavior. `alerts` is unchanged (tracking matches reuse
`label`/`ruleId`/`severity`).

## Worker changes

### New dependency
`supervision` added to `worker/requirements.txt` (provides `supervision.ByteTrack`;
pulls numpy, already present via opencv). Kept out of the pure-logic imports.

### New `worker/app/tracker.py`
```python
@dataclass
class Track:
    id: int
    x: float; y: float; w: float; h: float   # normalized, like Box
    conf: float
    label: str

class Tracker(ABC):
    @abstractmethod
    def update(self, boxes: list[Box], frame_w: int, frame_h: int) -> list[Track]: ...

class ByteTrackTracker(Tracker):
    # one per camera. Wraps supervision.ByteTrack:
    #   build sv.Detections(xyxy=pixel, confidence, class_id=label->coco id)
    #   det = self._bt.update_with_detections(det)
    #   -> Track per row that got a tracker_id (skip None), boxes back to normalized
```
Heavy import (`supervision`) local to `ByteTrackTracker.__init__` so the pure
tracking-rules tests don't need it. A `Track` is duck-typed (has `.x .y .w .h
.conf .label .id`), so tests use a plain fake.

### New pure `worker/app/tracking_rules.py`
```python
def bottom_center(o) -> tuple[float, float]      # (o.x + o.w/2, o.y + o.h)
def segment_crosses(prev, cur, line, direction) -> bool
    # line = [{"x","y"},{"x","y"}]; prev/cur = (x,y) normalized.
    # True iff the prev->cur segment intersects the line segment AND the crossing
    # sense matches direction: side sign via cross product of (B-A)x(P-A);
    # 'in' = prev side<0 & cur side>=0 (A->B); 'out' = reverse; 'both' = either.

class DwellState:            # per (rule_id, track_id): entered_at: float|None, fired: bool

def evaluate_tracking(tracks, rules, state, last_center, now_s, now_hhmm, default_conf) -> list[Match]
    # for each enabled tracking rule whose schedule is active:
    #   filter tracks by class in rule.classes and conf >= min_confidence
    #   tripwire: for each such track with a last_center, if segment_crosses(
    #     last_center[id], bottom_center(track), rule.line, rule.direction) -> Match
    #   dwell: for each such track: inside = point_in_polygon(bottom_center, rule.zone);
    #     inside & no entry -> record entered_at=now_s; inside & now_s-entered>=dwell &
    #     not fired -> Match + fired=True; not inside -> clear that (rule,track) state
    # Match reuses M2a Match{rule_id, severity, label=track.label, boxes=[track], count=1, confidence}
```
`point_in_polygon` is imported from `rules.py` (M2a) — shared, already tested.

### `camera_worker.py`
- Construct one `ByteTrackTracker` per camera (behind the `Tracker` interface).
- Split `self.rules` into presence vs tracking at `set_rules` time (by `type`).
- Per frame: `tracks = self.tracker.update(boxes, w, h)`; keep
  `self._last_center: dict[int, tuple] ` and a dwell `self._dwell_state` dict; run
  presence `evaluate` (M2a) AND `evaluate_tracking`; merge matches; emit each that
  is new. Update `_last_center` from this frame's tracks after evaluation.
- **Dedup:** presence matches keep the M2a per-(camera,rule) count-dedup. Tracking
  matches **bypass** that dedup — tripwire (once per crossing) and dwell (once per
  episode) are inherently rate-limited by their own logic; the count-based window
  dedup would wrongly suppress a second person crossing within the window.
- Recorder (M1) still triggers once per frame that emits ≥1 match (any type).
- Annotate: draw the track id next to the label when a box came from a track
  (nice-to-have; keep simple — reuse existing box draw).

## Event & command contract

`resolveRules` (backend) gains `type`, `direction`, `dwell_seconds`, and the zone
`kind` alongside the inlined points, so a resolved tracking rule is
self-contained:
```json
{ "id":"…","type":"tripwire","classes":["person"],
  "zone":[{"x":0.2,"y":0.5},{"x":0.8,"y":0.5}], "zone_kind":"line",
  "direction":"in","dwell_seconds":null,
  "schedule":[null,null],"min_confidence":0.4,"severity":"high","enabled":true }
```
The detection event is unchanged. `docs/EVENT_FORMAT.md` §1 is updated to note the
new rule fields in the `start`/`rules_update` payloads.

## API changes

- **zones**: accept + validate `kind` on POST/PATCH — `line` requires exactly 2
  points, `polygon` requires ≥3. Default `polygon`.
- **rules**: validate `type ∈ {presence,tripwire,dwell}`; a `tripwire` rule
  requires a `line`-kind zone **and** `direction ∈ {in,out,both}`; a `dwell` rule
  requires a `polygon`-kind zone **and** `dwellSeconds > 0`; `presence` unchanged.
  Reject a tripwire pointing at a polygon zone (and vice-versa) with 400.
- **resolveRules**: include `type`, `direction`, `dwellSeconds`, `zone_kind`.
- Ownership/scoping unchanged (still via `ownedCamera` / `zoneBelongs`).

## Frontend changes

- **Zone editor**: a **polygon | line** mode toggle. Line mode = click exactly 2
  points; render the line with a **direction arrow** (A→B). Save with `kind`.
- **Rules panel**: a rule-**type** selector (presence / tripwire / dwell). Tripwire
  → a line-zone dropdown + direction select (in/out/both). Dwell → a polygon-zone
  dropdown + a dwell-seconds number input. Presence → unchanged (whole-frame or
  polygon zone). The form only shows the fields relevant to the chosen type and
  filters the zone dropdown to the matching kind.
- **Alerts**: already show label + severity + rule name; no change (the rule name
  conveys the type). `lib/types` `Rule` gains `type/direction/dwellSeconds`;
  `Zone` gains `kind`.

## Backward compatibility

Existing rules are `type='presence'` and behave exactly as M2a. Existing zones are
`kind='polygon'`. No migration of data needed beyond the column defaults. The
implicit "any person, low" default (no rules) is unchanged.

## Testing

- **Worker (pure, no supervision/torch):**
  - `tracking_rules.py`: `segment_crosses` (crossing vs no-crossing; `in`/`out`/
    `both` direction sense; a segment that touches the infinite line but misses the
    segment extent → no crossing); dwell state (fires once at threshold; resets on
    leave; re-entry = new episode; not-yet-threshold → no fire); class/conf filter.
  - `tracker.py`: the `ByteTrackTracker` wrapper's box↔pixel conversion + `Track`
    mapping is tested with a fake `sv.ByteTrack` (inject the tracker object) so no
    real dependency is needed; ID stability is delegated to ByteTrack (not re-tested).
- **Backend (throwaway Postgres):** zone `kind` validation (line=2pts, polygon≥3);
  rule `type` validation (tripwire needs line+direction, dwell needs polygon+
  seconds, mismatched kind → 400); `resolveRules` includes the new fields.
- **Frontend:** `npm run build`; the line-vs-polygon save shape is a pure helper
  with a unit test.

## Rollout / definition of done

`docker compose up` → draw a **line** across the walk path, add a `tripwire` rule
(person, direction `both`) → a person walking through raises a tripwire alert
tagged with the rule; draw a **polygon** zone, add a `dwell` rule (person, 3s) → a
person lingering ≥3s raises one dwell alert (and not again until they leave and
return). Presence rules and M1 clips still work; worker CPU rises only modestly
(ByteTrack is cheap vs the YOLO forward pass).
