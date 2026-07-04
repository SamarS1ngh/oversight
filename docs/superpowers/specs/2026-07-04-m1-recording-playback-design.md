# M1 — Recording & Playback (event-clips)

**Date:** 2026-07-04
**Milestone:** M1 of the [OSS VMS roadmap](./2026-07-04-oss-vms-product-roadmap.md)
**Goal:** When a detection fires, record a short video clip (with footage from
*before* the trigger), store it on disk with a thumbnail, link it to the alert,
and let the user watch/download it in the browser. Retention prunes old clips.

## Scope

**In:** event-triggered clips only. Pre-roll + live + post-roll. Local-disk
storage (pluggable interface, S3 stub for later). Retention by age + size.
Thumbnails. Alert→clip linkage over the existing event bus. Clip list + player UI
+ export.

**Out (this milestone):** continuous 24/7 recording, 24/7 scrub timeline, S3/MinIO
implementation, motion-only (no-person) recording. Continuous recording is a
later toggle inside the same subsystem.

## Decisions locked

- **Capture = A1: encoded-packet ring buffer, codec-copy (remux), no re-encode.**
  Chosen because the worker already ingests via **PyAV** (`av.open`), which
  exposes compressed H.264 packets. We keep a rolling deque of recent packets and
  mux them into an MP4 on trigger. Near-zero extra CPU, true pre-roll, event-only
  on disk. (Rejected: A2 re-encode decoded frames — high CPU/camera; A3 second
  RTSP pull + ffmpeg segments — extra connection, not truly event-only.)
- **Retention default = 7 days OR 10 GB, whichever hits first**, evict oldest.
  Both env-tunable.
- **Storage default = local shared Docker volume.** Backend interface is
  pluggable; S3/MinIO is a stub implemented in a later (cloud) milestone.
- **Format = fragmented MP4** (browser-seekable via HTTP Range).
- **One active recording per camera.** A new trigger during recording *extends*
  the post-roll; it never starts a second concurrent clip.
- **A clip is triggered only by an *emitted* detection** (one that passed
  dedup/rate-limit and became a persisted alert). Keeps clips 1:1 with alerts and
  avoids clip spam.

## Architecture

Fits the existing two-plane split. Recording lives entirely in the **worker**
(closest to the packet stream, like dedup). The **API** owns the `clips` table,
serves the files, and prunes. Nothing new on the media (WebRTC) plane.

```
Worker (per CameraWorker)
  demux ─┬─> packet ──> ring buffer (deque, ~PRE_ROLL_S of packets)
         └─> decode ──> frame ──> YOLO ──(emitted detection)──> Recorder.trigger()
                                                       │
  Recorder: mux [buffer-from-keyframe] + [live pkts POST_ROLL_S] -> clip.mp4
            grab annotated frame -> thumb.jpg
            publish "clip_ready" on Redis channel `clips`
                                                       │
API  subscribe `clips` -> insert clips row (link alert_id) -> WS fanout to owner
     GET /clips, GET /clips/:id/video (Range), /thumb, DELETE
     pruner (periodic): age + size eviction (row + file + thumb)

Frontend
  CameraTile alert -> thumbnail + play button (appears live on clip_ready)
  Events page -> clip grid + filters + modal <video> player + download
```

## Worker changes

### Decode loop (`camera_worker.py`)
Switch `for frame in container.decode(stream)` to demux-then-decode so we hold the
compressed packet **and** the decoded frame from one pass:

```python
for packet in container.demux(stream):
    recorder.on_packet(packet)          # ring buffer + active-clip muxing
    for frame in packet.decode():
        img = frame.to_ndarray(format="bgr24")
        # ... existing fps / detect / annotate / latest_frame path ...
        if emitted_detection:
            recorder.trigger(trigger_frame=annotated_img, alert_id=det_id, stream=stream)
```

`container.demux(stream)` yields the same media `container.decode(stream)` did;
`packet.decode()` yields the frames. No behavior change to detection/WebRTC.

### New module `worker/app/recorder.py`
`Recorder` (one per `CameraWorker`):
- `on_packet(packet)`: append to `deque(maxlen bounded by PRE_ROLL_S)`; if a clip
  is active, `mux(packet)` into the open output and check stop conditions.
- `trigger(trigger_frame, alert_id, stream)`:
  - If a clip is already active → extend stop-time to `now + POST_ROLL_S`
    (capped so total length ≤ `MAX_CLIP_LEN_S`). Return.
  - Else start a clip: open MP4, `add_stream(template=stream)` (codec copy), write
    buffered packets **from the most recent keyframe at/before now−PRE_ROLL_S**,
    then let `on_packet` continue muxing live packets. Record `alert_id`, `start_ts`.
    Save `trigger_frame` as `thumb.jpg`.
- Finalize when live time passes stop-time (or camera stops / `MAX_CLIP_LEN_S`
  reached): close MP4, compute `duration_ms`/`size_bytes`, publish `clip_ready`.
- Files: `RECORDINGS_DIR/<camera_id>/<clip_id>.mp4` and `<clip_id>.jpg`.
- Runs in the existing decode thread (no new thread); muxing is cheap byte-copy.

Keyframe rule: a clip must start on a keyframe (`packet.is_keyframe`), else the
first frames are undecodable. The buffer scan picks the newest keyframe ≤ the
pre-roll start.

### `clip_ready` event (new, Redis channel `clips`)
```json
{
  "type": "clip_ready",
  "id": "<clip uuid>",
  "alert_id": "<triggering detection/alert uuid>",
  "camera_id": "<uuid>",
  "start_ts": "2026-07-04T13:59:01.500Z",
  "end_ts":   "2026-07-04T13:59:21.500Z",
  "duration_ms": 20000,
  "size_bytes": 1830000,
  "path": "<camera_id>/<clip_id>.mp4",
  "thumb_path": "<camera_id>/<clip_id>.jpg",
  "backend": "local",
  "worker_id": "worker-1"
}
```
Documented alongside the others in `docs/EVENT_FORMAT.md`.

### New config (`worker/app/config.py`)
| Var | Default | Purpose |
|---|---|---|
| `PRE_ROLL_S` | `10` | seconds of footage kept before trigger |
| `POST_ROLL_S` | `10` | seconds recorded after last trigger |
| `MAX_CLIP_LEN_S` | `120` | hard cap on a single extended clip |
| `RECORDINGS_DIR` | `/recordings` | clip/thumb output root |
| `STORAGE_BACKEND` | `local` | `local` (only impl this milestone) |

## Backend changes

### Schema — new `clips` table (`db/schema.ts`)
```
id           uuid pk (worker-generated, idempotency key)
cameraId     uuid -> cameras.id (cascade delete)
alertId      uuid nullable -> alerts.id (set null on alert delete)
backend      text default 'local'
path         text                 -- relative to RECORDINGS_DIR
thumbPath    text
startTs      timestamptz
endTs        timestamptz
durationMs   integer
sizeBytes    integer
createdAt    timestamptz default now
index (cameraId, startTs)
```
Applied via `drizzle-kit push`. `alerts` query response gains `clipId` + a derived
`thumbUrl` when a clip exists (left join on `clips.alertId`).

### Routes — new `clips/routes.ts` (all JWT + owner-scoped, join on camera ownership)
| Method | Path | Notes |
|---|---|---|
| `GET` | `/clips?camera_id&from&to&limit&offset` | list, newest first, paginated |
| `GET` | `/clips/:id/video` | stream MP4, **HTTP Range** (206 partial) for seek/scrub |
| `GET` | `/clips/:id/thumb` | jpg poster |
| `DELETE` | `/clips/:id` | delete row + file + thumb |

Auth for media: `<video>` can't send an `Authorization` header, so `/video` and
`/thumb` also accept `?token=<jwt>` (same pattern the WS already uses). Verified
server-side; ownership enforced regardless.

### Ingest — subscribe `clips` (`realtime/ingest.ts`)
On `clip_ready`: insert `clips` row (idempotent on `id`), then fan out over WS as a
new envelope `{ channel: "clip", data: {...} }`, filtered to the owning user.

### Pruner (`realtime/` or a small `retention.ts`, started in `index.ts`)
Periodic (every 5 min): delete clips older than `RETENTION_DAYS`; then while total
`sizeBytes` > `MAX_STORAGE_GB`, delete oldest until under. Each deletion removes
row + mp4 + jpg. No import-time side effects (started from `index.ts`, not `app.ts`).

New backend env: `RECORDINGS_DIR` (`/recordings`), `RETENTION_DAYS` (`7`),
`MAX_STORAGE_GB` (`10`).

## Frontend changes

- `lib/types.ts`: add `Clip`; extend `Alert` with `clipId?`, `thumbUrl?`.
- `lib/api.ts`: `listClips(params)`, `deleteClip(id)`, URL helpers
  `clipVideoUrl(id)` / `clipThumbUrl(id)` (append `?token=`).
- `lib/realtime.ts`: handle the new `clip` channel → update the matching alert in
  place (swap in thumbnail + play button live, no refresh).
- `components/CameraTile.tsx`: each alert row shows the thumbnail; a play button
  appears once the clip lands → opens the player modal.
- New `app/events/page.tsx` (+ a small `ClipPlayer` modal component): thumbnail
  grid of clips, filter by camera + time range, click → native `<video controls>`
  (range seek), download button. Event-list layout (matches event-only mode; not a
  24/7 scrubber).

## Infra changes

`docker-compose.yml`: add a named volume `recordings`, mounted `rw` on `worker`
and `ro` on `backend`. (Worker keeps `network_mode: host`; volumes are
unaffected.) Document the new env vars in `.env.example` and the README config
table.

## Testing

- **Worker** (`tests/test_recorder.py`, import-light — synthetic packets, no
  torch/av-encode): keyframe-trim picks the right start packet; `trigger` while
  active extends instead of starting a second clip; `MAX_CLIP_LEN_S` cap; finalize
  emits a well-formed `clip_ready`.
- **Backend** (`test/clips.test.ts`, against throwaway Postgres, self-skips w/o
  DB): ownership scoping (can't read another user's clip), Range request returns
  `206` with correct bytes, pruner age + size eviction math, `DELETE` removes row
  and files.
- Existing tests unchanged; `app.ts` stays side-effect-free (pruner in `index.ts`).

## Rollout / definition of done

`docker compose up` → start the demo camera → walk-in on the sample clip →
within ~POST_ROLL_S an alert row gains a thumbnail + play button → clicking plays
an MP4 that **includes ~10s before the person appeared** → the clip appears in the
Events page → after retention limits, old clips are pruned. Worker CPU per camera
is essentially unchanged vs today (codec-copy).
