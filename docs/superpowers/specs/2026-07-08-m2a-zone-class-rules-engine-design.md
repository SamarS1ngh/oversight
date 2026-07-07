# M2a — Zone & Class Rules Engine

**Date:** 2026-07-08
**Milestone:** M2a of the [OSS VMS roadmap](./2026-07-04-oss-vms-product-roadmap.md)
**Goal:** Turn the always-on "a person exists → alert" firehose into a per-camera
**rules engine**: alert on `{object class}` inside `{drawn zone}` during
`{schedule}` at a chosen `{severity}`, with an acknowledge/resolve workflow. No
object tracking (that's M2b: tripwire + dwell).

## Scope

**In:** multi-class detection; per-camera **zones** (drawn polygons); per-camera
**rules** referencing an optional zone + classes + schedule + min-confidence +
severity; worker-side rule evaluation (point-in-polygon, schedule, per-rule
dedup); implicit "any person, low" default when a camera has no rules; alert
`label`/`ruleId`/`severity`/`status`; ack/resolve API + UI; zone editor + rules
config UI + severity/ack display.

**Out (this milestone → M2b):** object tracking, tripwire/line-crossing, dwell/
loiter. Anything needing track identity across frames.

## Decisions locked (from brainstorming)

- **Rules-engine model:** zones are geometry; **rules reference zones**. Many
  rules per zone; a rule may omit the zone (whole frame). A detection matching
  *any* enabled rule produces an alert tagged with that rule.
- **No-rules default = implicit:** a camera with zero enabled rules behaves as
  today — alert on any `person`, `severity=low`, `ruleId=null`. Adding a rule
  switches the camera to rules-only. Never silent; no migration of existing rows.
- **Ack model:** alert `status` = `new → acked → resolved`.
- **Zone snapshot:** drawn on a frame grabbed **client-side** from the live
  WebRTC `<video>` (canvas `drawImage`) — no new backend snapshot endpoint. Zones
  are therefore drawn while the camera is running (UI prompts to start otherwise).
- **Schedules:** compared in the worker's local timezone (`TZ` env, default UTC),
  wrap-around windows allowed (`22:00→06:00`).
- **Severity:** `low | medium | high`.
- **"In zone":** the box's **bottom-center** point `(x + w/2, y + h)` (ground
  contact) is tested against the polygon (ray-casting).

## Architecture

Fits the existing planes. Rule evaluation lives in the **worker** (closest to the
detection firehose, exactly like dedup). The **API** owns the `zones`/`rules`
tables and pushes a camera's rules to the worker over Redis on start and on every
rule/zone change. Media/WebRTC plane is untouched.

```
API (owns DB)                         Worker (per CameraWorker)
  zones/rules CRUD ──publish──▶ Redis camera:commands
    • start {…, rules:[…]}              handle_command:
    • rules_update {camera_id, rules}     start   → CameraWorker(rules)
                                          rules_update → worker.set_rules(rules)
  ingest detections ◀──Redis detections── evaluate(objects, rules, now_local)
    persist alert (label, rule_id,         detect_objects()  [multi-class YOLO]
    severity, status=new) ─WS▶ browser     rules.py: class∈ ∧ conf≥ ∧ in-zone ∧
                                            schedule → Match{rule_id,severity,
  ack/resolve endpoints                     label,boxes}; per-(cam,rule) dedup
```

## Data model

### New `zones` table
```
id         uuid pk default random
cameraId   uuid → cameras.id (cascade delete)
name       text not null
polygon    jsonb not null      -- [{ "x":0.12, "y":0.34 }, …] normalized 0..1, ≥3 pts
createdAt  timestamptz default now
index (cameraId)
```

### New `rules` table
```
id             uuid pk default random
cameraId       uuid → cameras.id (cascade delete)
name           text not null
zoneId         uuid → zones.id (set null on zone delete)   -- null = whole frame
classes        jsonb not null    -- ["person","car"] (≥1)
scheduleStart  text              -- "HH:MM" local, nullable
scheduleEnd    text              -- "HH:MM" local, nullable (null start&end = always)
minConfidence  real not null default 0.4
severity       text not null default 'low'   -- low|medium|high
enabled        boolean not null default true
createdAt      timestamptz default now
updatedAt      timestamptz default now
index (cameraId)
```

### `alerts` — added columns (existing columns unchanged)
```
label       text                          -- object class, e.g. "person","car"
ruleId      uuid → rules.id (set null)    -- null for implicit-default alerts
severity    text not null default 'low'
status      text not null default 'new'   -- new|acked|resolved
ackedAt     timestamptz
resolvedAt  timestamptz
```
Applied via `drizzle-kit push`; existing rows default to `label=null`,
`severity='low'`, `status='new'`. `count`/`bboxes`/`confidence` keep their meaning
but now describe the **matching** objects for that rule.

## Worker changes

### `detector.py` — multi-class
`YoloDetector.detect_persons(frame)` → `detect_objects(frame)` returning
`Box(x, y, w, h, conf, label)` for a curated COCO subset. Class map (COCO id →
name): person 0, bicycle 1, car 2, motorcycle 3, bus 5, truck 7, backpack 24,
handbag 26, suitcase 28, cat 15, dog 16. "package" is presented in the UI as an
alias for backpack/handbag/suitcase. `MODEL_CLASSES` env can override the set.
The `Box` dataclass gains `label: str`.

### New `worker/app/rules.py` (pure, unit-tested)
```python
def point_in_polygon(px, py, polygon) -> bool          # ray-casting, normalized
def schedule_active(start, end, now_hhmm) -> bool       # None/None = always; wrap ok
def evaluate(objects, rules, now_hhmm) -> list[Match]    # one Match per matching rule
```
- `objects`: list of detected boxes (with `label`, `conf`).
- `rules`: the camera's enabled rules (dicts). If the list is empty, `evaluate`
  synthesizes the implicit default `{id: None, classes: ["person"],
  zone: None, schedule: (None,None), min_confidence: CONF_THRESHOLD,
  severity: "low"}`.
- For each rule: keep objects with `label ∈ rule.classes` and
  `conf ≥ rule.min_confidence`; if `rule.zone` set, keep those whose bottom-center
  is inside the polygon; skip the rule entirely if its schedule is inactive.
  Non-empty survivors → `Match{rule_id, severity, label(top-conf), boxes, count}`.
- `Match` carries the matching boxes (each with its `label`) and the max-conf.

### `camera_worker.py`
- Holds `self.rules` (list). `set_rules(rules)` replaces it (called on
  `rules_update`). Constructed with the rules from the `start` payload.
- Per detected frame: `matches = rules.evaluate(objects, self.rules, now_local)`.
  For each match that passes the **per-(camera, rule)** dedup/rate-limit, emit a
  detection event (see contract). `annotated` frame still drives WebRTC + the
  recorder trigger (M1). The recorder still triggers on the first emitted match
  (clip 1:1 with the alert, unchanged).
- Timezone: `now_local` = `datetime.now(tz)` where `tz` from `TZ` env (default UTC),
  formatted `"HH:MM"`.

### `dedup.py`
Key generalized from `camera_id` to a composite `"{camera_id}:{rule_id}"` (rule_id
`""` for the implicit default) so rules don't cross-suppress. `reset(camera_id)`
clears all keys with that camera prefix.

## Event & message contract (`docs/EVENT_FORMAT.md`)

- **Camera command `start`** gains `rules: [...]` (the camera's enabled rules).
- **New command `rules_update`** on `camera:commands`:
  `{ "type": "rules_update", "camera_id": "…", "rules": [ … ] }`.
- **Detection event** gains `label`, `rule_id` (nullable), `severity`; each item in
  `bboxes` gains `label`. `count`/`confidence` describe the matching objects.
```json
{
  "id": "…", "type": "detection", "camera_id": "…", "ts": "…",
  "label": "person", "rule_id": "…|null", "severity": "high",
  "confidence": 0.91, "count": 1,
  "bboxes": [ { "x":0.1,"y":0.2,"w":0.3,"h":0.5,"conf":0.91,"label":"person" } ],
  "frame_w": 1280, "frame_h": 720, "worker_id": "worker-1"
}
```

## API changes

### Zones (owner-scoped via camera ownership, mirrors `cameras/routes.ts`)
| Method | Path | Notes |
|---|---|---|
| `GET` | `/cameras/:id/zones` | list |
| `POST` | `/cameras/:id/zones` | `{ name, polygon }` (polygon ≥3 pts, each 0..1) |
| `PATCH` | `/cameras/:id/zones/:zoneId` | partial |
| `DELETE` | `/cameras/:id/zones/:zoneId` | rules' `zoneId` set null |

### Rules
| Method | Path | Notes |
|---|---|---|
| `GET` | `/cameras/:id/rules` | list |
| `POST` | `/cameras/:id/rules` | validate: classes ⊆ known set, severity ∈ enum, zoneId owned, schedule `HH:MM` |
| `PATCH` | `/cameras/:id/rules/:ruleId` | partial |
| `DELETE` | `/cameras/:id/rules/:ruleId` | — |

Any successful create/update/delete of a rule **or** zone for a camera whose
`status` is running publishes `rules_update` with the camera's current enabled
rules (resolved with their zone polygons inlined) so the worker gets self-contained
rules. `start` embeds the same resolved rules.

### Alerts
- `GET /alerts` gains `severity` and `status` query filters (plus existing
  `camera_id/from/to/limit/offset`); response rows include the new columns.
- `POST /alerts/:id/ack` → `status=acked`, `ackedAt=now` (owner-scoped, 404 else).
- `POST /alerts/:id/resolve` → `status=resolved`, `resolvedAt=now`.

## Frontend changes

- **Zone editor** (`components/ZoneEditor.tsx`): modal over a camera. Grabs a
  still via `canvas.drawImage(videoEl)` from the tile's live `<video>`; user clicks
  to add polygon vertices, double-click/close to finish, names it, saves
  (normalized to the canvas size). Lists/deletes existing zones (drawn as
  overlays). If the camera isn't live, prompt "Start the camera to draw zones."
- **Rules panel** (`components/RulesPanel.tsx`): per-camera rule list + add/edit
  form (name, class multiselect, zone dropdown incl. "Whole frame", schedule
  start/end time inputs, min-confidence slider, severity select, enabled toggle).
- **Alerts**: each alert row shows a **severity dot** (low/med/high color), the
  `label`, the rule name (or "default"), and **Ack/Resolve** buttons that call the
  new endpoints; a severity/status filter on the Events page. `lib/types.ts` +
  `lib/api.ts` gain the zone/rule types + CRUD calls + ack/resolve.

## Backward compatibility

- Existing `person_detected` behavior is preserved for cameras with no rules (the
  implicit default). Existing alert rows get column defaults; the dashboard/Events
  pages keep working (new fields optional in the frontend types).
- M1 recording is untouched: the recorder still triggers on the first emitted
  match, so a clip is still 1:1 with the (now rule-tagged) alert.

## Testing

- **Worker** (import-light, no torch/av): `rules.py` — `point_in_polygon`
  (inside/outside/edge), `schedule_active` (normal window, wrap-around, all-day,
  boundaries), `evaluate` (class filter, conf threshold, zone containment, schedule
  gating, implicit default when rules empty, multiple simultaneous matches,
  per-match boxes). `dedup.py` — composite key isolates rules; `reset` clears a
  camera's keys.
- **Backend** (throwaway Postgres, self-skips w/o DB): zones/rules CRUD +
  ownership scoping; rule validation (bad class/severity/schedule → 400); a
  rule/zone change on a running camera publishes `rules_update`; `GET /alerts`
  severity/status filters; ack/resolve transitions + ownership.
- **Frontend**: `npm run build`; polygon normalization round-trip is a pure helper
  with a unit test.

## Rollout / definition of done

`docker compose up` → the seeded demo camera still alerts on people (implicit
default). Draw a "Driveway" zone on the live view; add a rule "person or car in
Driveway, 22:00–06:00, high"; a person walking into the zone during the window
raises a **high**-severity alert tagged with the rule, an out-of-window or
out-of-zone person does not; ack/resolve moves the alert through its states; the
M1 clip still attaches. Worker CPU is essentially unchanged (multi-class YOLO is
the same forward pass; rule eval is cheap geometry).
