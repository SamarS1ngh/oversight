# M4a — Camera Reconnect + Health

**Date:** 2026-07-14
**Milestone:** M4a of the [OSS VMS roadmap](./2026-07-04-oss-vms-product-roadmap.md)
**Goal:** Make cameras self-heal. Today a dropped RTSP stream goes to `error`
and stays dead until a manual restart. M4a adds automatic reconnect with
backoff, stall detection, an escalation to `offline` after a grace window, an
opt-in offline/recovery notification through the M3 pipeline, and health
(last-seen / fps / reconnects) in the UI.

## Scope

**In:** a worker reconnect loop (exponential backoff) that survives RTSP-open
failure and decode-loop exit; a stall watchdog (frozen-but-open streams); a
per-camera state machine `connecting → live ⇄ reconnecting → offline`; a grace
window before declaring `offline`; a per-camera **notify-if-offline** toggle
that dispatches an offline (and recovery) notification through the existing M3
channels; health fields (last-seen, fps, reconnect count) in stats + the UI.

**Out (later M4 sub-milestones):** ONVIF/RTSP **auto-discovery** (M4b); a
**durable event pipeline** (Redis Streams / outbox — M4c). No changes to the
detection/recording/notification logic beyond the new synthetic camera event.

## Decisions locked (from brainstorming)

- **Worker owns the connection state machine**; the backend reacts to
  `camera_state` events (updates status + health, dispatches notifications).
- **Reconnect = exponential backoff** 1s→2s→4s→…→**30s cap**, reset to 1s on a
  successful connect; retries forever until `stop()`.
- **Stall watchdog:** while `live`, if no decoded frame for ~10s
  (`STALL_TIMEOUT_S`), treat as a drop → tear down + reconnect.
- **Grace before offline:** a drop enters `reconnecting` (silent); only after
  continuously down > **grace ~60s** (`OFFLINE_GRACE_S`) → `offline` + notify.
  Brief blips never notify.
- **Notify is opt-in per camera** (`cameras.notifyOnOffline`, default false).
  On →`offline` and on recovery (→`live` from `offline`), if opted in, dispatch
  through M3. Composes with each channel's `cameraIds` + `minSeverity` filters +
  cooldown.
- **The camera event is NOT persisted to the alerts table** — it's a status
  transition (stored as `cameras.status`), dispatched as a transient
  notification only.

## State machine (worker, per camera)

```
stopped ──start──> connecting ──frames──> live
                       │                    │
                       │ open fails         │ drop / stall (no frame > STALL_TIMEOUT_S)
                       ▼                    ▼
                   reconnecting <───────────┘
                       │  backoff retry (1,2,4,…,30s)
                       │  reconnect ok ──> live   (reset backoff)
                       │  down > OFFLINE_GRACE_S
                       ▼
                    offline  ──reconnect ok──> live
   any state ──stop()──> stopped
```

`error` (the old terminal state) is removed — a persistent failure now sits in
`reconnecting` and escalates to `offline`; the reconnect loop keeps trying.

## Worker (`worker/app/camera_worker.py`)

- **Reconnect loop:** the run body wraps *open + decode* in a loop. On an
  exception (open failure or decode-loop exit) while not stopping: push
  `reconnecting`, sleep the current backoff, grow it (cap 30s), retry. A
  successful open pushes `live` and resets backoff to the floor.
- **Offline escalation:** track `reconnecting_since` (monotonic). Each retry,
  if `now - reconnecting_since > OFFLINE_GRACE_S` and not already `offline`,
  push `offline`. Reaching `live` clears it.
- **Stall watchdog:** the decode loop records `last_frame_at`; a check (in the
  loop or a lightweight timer) fires a reconnect if `live` and
  `now - last_frame_at > STALL_TIMEOUT_S`.
- **Health in stats:** `stats_event` gains `reconnect_count` (cumulative since
  `start`) and `last_frame_at` (iso). fps + state already flow.
- **Config (`config.py`):** `OFFLINE_GRACE_S` (60), `STALL_TIMEOUT_S` (10),
  `RECONNECT_BACKOFF_MAX_S` (30), `RECONNECT_BACKOFF_START_S` (1).

Pure, host-testable units (no PyAV): a `backoff_next(current, max)` and a
`ReconnectState` (or equivalent) advancing `connecting→live→reconnecting→
offline` from an injected clock + fake connector results.

## Backend

- **Schema (additive, `backend/src/db/schema.ts`):**
  - `cameras.lastSeenAt` — `timestamptz` null (last frame/live heartbeat).
  - `cameras.notifyOnOffline` — `boolean not null default false`.
- **`realtime/ingest.ts onStats`:** on a `camera_state` event, update
  `cameras.status` (existing) + `lastSeenAt = now`. Compute the transition from
  the prior status: entering `offline` (prior ≠ offline) → an **offline**
  notification; entering `live` with prior `offline` → a **recovery**
  notification. Gate on the camera's `notifyOnOffline`; look up the owner and
  dispatch.
- **Camera event dispatch (`notify/dispatch.ts`):** a
  `dispatchCameraEvent(camera, ownerId, kind)` (`kind: "offline" | "online"`)
  that builds a synthetic event `{ id: <uuid>, camera_id, severity: "high",
  label: kind === "offline" ? "camera offline" : "camera back online",
  rule_id: null, ts, count: 0, confidence: 0 }` and runs the existing
  `shouldNotify` (cameraIds + min-severity) + `allow` (cooldown) + `renderAlert`
  + `sendChannel` loop — the same non-blocking, per-channel-try/catch envelope as
  `dispatchNotifications`. No snapshot, no alert-row insert, no retry-queue
  enqueue for a camera event (transient). Reuses the pipeline; does not fork it.
- **Camera CRUD (`cameras/routes.ts`):** `PATCH /cameras/:id` accepts
  `notifyOnOffline` (boolean). `GET` returns it + `lastSeenAt`.

## Frontend

- **`lib/types.ts`:** `CameraStatus` gains `"reconnecting" | "offline"` (keep
  the union aligned with the worker states); `Camera` gains
  `notifyOnOffline: boolean` + `lastSeenAt: string | null`.
- **Camera card / dashboard:** status badge colors — `reconnecting` amber,
  `offline` red (live green, connecting/stopped as today). Show **last-seen**
  (relative), **fps**, **reconnect count** (from the stats stream). A **"Notify
  if offline"** toggle calling `updateCamera(id, { notifyOnOffline })`.

## Backward compatibility

Additive. `lastSeenAt`/`notifyOnOffline` are nullable/defaulted; existing
cameras get `notifyOnOffline=false` (no new notifications — unchanged behavior).
Removing `error` in favor of `reconnecting`/`offline` is a superset of states;
the frontend union is extended, not broken. Detection/recording/M3 delivery are
untouched except the new synthetic camera-event dispatch (guarded by the
per-camera opt-in, wrapped so a failure can't affect stats ingest).

## Testing

- **Worker (pure/host):** `backoff_next` (grows, caps at 30s, resets); the state
  machine — a drop → `reconnecting`; `reconnecting` past `OFFLINE_GRACE_S` →
  `offline`; a successful reconnect → `live` + backoff reset; a stall (no frame
  > `STALL_TIMEOUT_S`) → reconnect. Injected clock + fake connector, no PyAV.
- **Backend (DB):** `notifyOnOffline` CRUD; `onStats` updates status +
  `lastSeenAt`; an `offline` transition with `notifyOnOffline=true` dispatches
  (capture-server assert) and with `false` does not; recovery dispatches; a
  flapping offline/online burst collapses to one per cooldown window.
- **Frontend:** `npm run build`; the badge + health + toggle render.
- **Live e2e (docker):** camera `live`; `docker stop streamer` (or block the
  RTSP) → worker → `reconnecting`, then `offline` after the grace; an opt-in
  camera fires an offline notification (capture server); `docker start streamer`
  → `reconnecting` → `live` + a recovery notification; alert persistence and the
  other cameras are unaffected throughout.

## Rollout / definition of done

`docker compose up`, camera `live`. Cut the stream (stop the streamer/mediamtx
or unplug the source): the card shows `reconnecting`, then `offline` after ~60s;
a camera with **Notify if offline** on delivers an offline notification to the
configured channels. Restore the stream: the card returns to `live` within a
backoff cycle and a recovery notification arrives. A brief (<grace) blip shows
`reconnecting` and self-heals with **no** notification. Health (last-seen, fps,
reconnects) is visible per camera. No manual restart is ever needed for a
recoverable drop.
