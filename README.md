# Real-Time Camera Surveillance Dashboard (WebRTC + Person Detection)

A small **Video Management System (VMS)**. Register cameras by RTSP URL, watch
the live feed in the browser over **WebRTC**, and get **real-time person-detection
alerts** the instant someone walks into frame — no page refresh.

Three application services + Postgres + Redis, wired together with Docker
Compose. Bring the whole stack up with one command, log in with a seeded demo
account, hit **Start** on the pre-seeded camera, and watch live video with
person bounding boxes plus alerts and FPS/detections-per-minute updating live.

> Built as the Skylark Labs "Real-Time Camera Surveillance Dashboard" assignment.
> All three core services, the cross-service event contract, and four of the
> bonus items (message queue, tests, dedup, rate-limiting) are implemented.

---

## Table of contents

- [Architecture](#architecture)
- [Requirement coverage](#requirement-coverage)
- [Tech stack & why](#tech-stack--why)
- [Detection model — YOLOv8n, and why](#detection-model--yolov8n-and-why)
- [Data flow, end to end](#data-flow-end-to-end)
- [Event & message format](#event--message-format)
- [HTTP API reference](#http-api-reference)
- [WebSocket protocol](#websocket-protocol)
- [WebRTC signaling](#webrtc-signaling)
- [Dedup & rate-limiting](#dedup--rate-limiting)
- [Running it](#running-it)
- [Configuration](#configuration)
- [Testing](#testing)
- [Project layout](#project-layout)
- [Design decisions](#design-decisions)
- [Scaling notes](#scaling-notes)
- [Troubleshooting](#troubleshooting)
- [Future improvements](#future-improvements)

---

## Architecture

```
                       ┌──────────────────────────────────────────────┐
                       │                  Browser                      │
                       │   Next.js (React 19 + TS)                     │
                       │   • login / JWT       • camera CRUD           │
                       │   • dashboard grid    • <video> over WebRTC   │
                       └───────▲───────────────▲──────────────▲────────┘
                          REST │          WS   │     WebRTC    │ (SDP/ICE
                          +JWT │   (alerts+    │   media       │  via API)
                               │    stats)     │               │
                       ┌───────┴───────────────┴───────┐       │
                       │      Backend API              │       │
                       │      Bun + Hono               │       │
                       │  • auth  • CRUD  • alerts      │       │
                       │  • WS fan-out  • SDP relay     │       │
                       └───┬───────────────▲────────────┘       │
                  publish  │ camera:commands│ detections+stats   │
                           ▼               │ (subscribe)         │
                       ┌───────────────────┴───────┐             │
                       │           Redis            │             │
                       │   pub/sub message bus      │             │
                       └───────────────▲────────────┘             │
                       commands (sub)  │  events (pub)            │
                       ┌───────────────┴────────────────────────┐ │
                       │              Worker (Python)            │ │
                       │  • RTSP ingest (OpenCV/FFmpeg)          │ │
                       │  • YOLOv8n person detection             │◄┘
                       │  • WebRTC re-stream (aiortc)            │  peer connection
                       │  • emit detections + stats              │
                       └─────────────────▲──────────────────────┘
                                         │ RTSP
                       ┌─────────────────┴──────────────────────┐
                       │   mediamtx — loops a sample video as    │
                       │   an RTSP source (no real camera needed)│
                       └─────────────────────────────────────────┘

         Postgres ── stores users, cameras, alerts (owned by API)
```

Two transport planes deliberately kept separate:

- **Control + alerts plane** — REST (JSON over HTTP, JWT-guarded) for CRUD and
  start/stop, plus a single WebSocket per browser for live alerts and stats.
  Everything between API and worker rides Redis pub/sub.
- **Media plane** — raw H.264 video flows browser ↔ worker directly over a
  **WebRTC peer connection**. It never passes through the API or Redis; only the
  SDP offer/answer handshake is relayed. This keeps video off the application
  hot path.

---

## Requirement coverage

| Requirement | Status | Where |
|---|:--:|---|
| Login (username/password) + JWT + protected routes | ✅ | `backend/src/auth/`, `frontend/app/login` |
| Camera CRUD (RTSP URL, name, location, enabled), per-user | ✅ | `backend/src/cameras/routes.ts` |
| Dashboard grid of camera tiles | ✅ | `frontend/app/dashboard`, `components/CameraTile.tsx` |
| Live WebRTC video per tile | ✅ | `frontend/lib/webrtc.ts`, worker `signaling.py` |
| Recent alerts per tile | ✅ | `CameraTile.tsx` + `GET /alerts` |
| Start/Stop with live state (connecting/live/stopped/error) | ✅ | start/stop routes + state events |
| Realtime alerts + per-camera stats (FPS, det/min) over WS | ✅ | `backend/src/realtime/`, `frontend/lib/realtime.ts` |
| Backend: auth, CRUD, start/stop, alerts w/ filter + pagination | ✅ | `backend/src/` |
| Postgres + one event format across all layers | ✅ | `docs/EVENT_FORMAT.md`, Drizzle schema |
| Worker: many cameras concurrently + independently | ✅ | `worker/app/main.py`, `camera_worker.py` |
| Worker: RTSP ingest → detection → WebRTC re-stream → post events | ✅ | `worker/app/` |
| Open-source detection model (stated + justified) | ✅ | YOLOv8n — see below |
| Dockerized + `docker compose up` | ✅ | `docker-compose.yml` |
| **Bonus:** message queue for commands + events | ✅ | Redis pub/sub |
| **Bonus:** unit + integration tests | ✅ | `backend/test/`, `worker/tests/` |
| **Bonus:** alert dedup + rate-limiting | ✅ | `worker/app/dedup.py` |
| **Bonus:** scalable architecture | ◑ | stateless worker, sharding-ready (see [Scaling](#scaling-notes)) |
| **Bonus:** Kubernetes deploy | ✗ | not implemented (future) |
| **Bonus:** demo video / deploy URL | ◑ | optional per spec |

✅ done · ◑ partial / design-level · ✗ not done

---

## Tech stack & why

| Concern | Choice | Why |
|---|---|---|
| Frontend | Next.js 15 (React 19 + TS) | Spec wants React + TS; Next gives routing + protected routes cheaply. |
| Backend | Bun + Hono 4 + Postgres | Per spec. Bun ships a native WebSocket server — cleaner than bolting WS onto a framework that fights it. |
| ORM | Drizzle | Typed schema, trivial migrations (`drizzle-kit push`), no heavy runtime. |
| Worker | Python + aiortc + ultralytics | aiortc is the most batteries-included WebRTC stack outside the browser; ultralytics YOLO is one import to a pretrained person detector. Spec allows any language, so we optimize for a working pipeline over Go's heavier WebRTC+ML plumbing. |
| Detection | **YOLOv8n** (COCO, class 0 = person) | See below. |
| Message bus | Redis pub/sub | Decouples API from worker; commands and events flow without a direct socket. One small container. |
| DB | Postgres 16 | Per spec. Relational fit: users → cameras → alerts. |
| Test RTSP | mediamtx + ffmpeg loop | Reproducible, no hardware, comes up inside compose. |

**Pinned versions:** Bun (latest), Hono `4.6`, Drizzle `0.36`, ioredis `5.4`,
postgres-js `3.4` · Next `15.5`, React `19` · aiortc `1.9`, av `12.3`,
opencv-python-headless `4.10`, ultralytics `8.3` · Postgres `16-alpine`,
Redis `7-alpine`, mediamtx `1.9.3`.

---

## Detection model — YOLOv8n, and why

- **Pretrained on COCO**, which includes a `person` class (class id 0). No
  training needed — we filter detections to class 0.
- **`n` = nano**: the smallest YOLOv8 variant (~3M params). On CPU it sustains a
  usable frame rate for several concurrent cameras; on GPU it's trivial. We
  optimize for "runs on a laptop in `docker compose up`", not max mAP.
- **One-line inference** via `ultralytics`, and it exports cleanly to ONNX if you
  later want `onnxruntime` without the heavy torch dependency.
- **Open source** (AGPL-3.0). Noted because the spec asks which model and why.

**Cost controls baked in:** the worker runs YOLO on every `DETECT_EVERY_N`th
decoded frame (default 3), not every frame — detection is the expensive step,
re-streaming is cheap, so this multiplies throughput with negligible miss rate
for the "is a person present" question. CPU-only torch wheels are installed in
the worker image so it never pulls the multi-GB CUDA build.

Swappable: the detector sits behind a `Detector` interface (`worker/app/detector.py`),
so YOLOv5n / RT-DETR / an ONNX model drops in without touching the pipeline.

---

## Data flow, end to end

**Starting a camera**

1. Browser → `POST /cameras/:id/start` (JWT). API marks the camera
   `connecting` (optimistic) and publishes a `start` command on Redis
   `camera:commands`.
2. Worker receives the command, spins up an isolated `CameraWorker` task: opens
   the RTSP stream, begins decoding, and emits a `camera_state` event
   (`connecting` → `live`).
3. Worker emits `camera_stats` ~1×/sec (FPS, detections/min, state).

**Watching the video**

4. Browser creates an `RTCPeerConnection`, generates an SDP **offer**, and
   `POST`s it to `POST /cameras/:id/webrtc`.
5. API relays the offer to the worker over Redis (`webrtc:requests`), keyed by a
   `reqId`, and waits (RPC-over-pubsub, 8s timeout).
6. Worker attaches the decoded video track to the peer connection, produces an
   SDP **answer**, and publishes it on `webrtc:answers` with the same `reqId`.
7. API routes the answer back to the waiting HTTP request → browser. ICE
   completes and **video flows worker → browser directly** (never through the API).

**Detections**

8. On every Nth frame the worker runs YOLOv8n. If ≥1 person is found (and it
   survives dedup/rate-limit), it emits a `person_detected` event on `detections`.
9. API's Redis subscriber persists it to the `alerts` table (idempotent on the
   worker-generated `id`) and fans it out over WebSocket to the owning user only.
10. Browser's WS handler appends the alert to the tile and updates stats — no
    refresh.

**Stopping** — `POST /cameras/:id/stop` → `stop` command → worker tears down that
camera's task and peer connection; other cameras are unaffected.

---

## Event & message format

The contract every service shares is the **single source of truth** in
[`docs/EVENT_FORMAT.md`](docs/EVENT_FORMAT.md). Defined once, identical shape end
to end. Summary:

| # | Message | Direction | Redis channel |
|---|---|---|---|
| 1 | Camera command (`start`/`stop`) | API → Worker | `camera:commands` |
| 2 | Detection event (`person_detected`) | Worker → API → DB → WS | `detections` |
| 3 | Camera stats (FPS, det/min, state) | Worker → API → WS | `stats` |
| 4 | Camera state change | Worker → API → WS | `stats` |
| 5 | WebRTC offer (`reqId`, sdp) | API → Worker | `webrtc:requests` |
| 6 | WebRTC answer (`reqId`, sdp) | Worker → API | `webrtc:answers` |

Detection event (the one that gets persisted), abbreviated:

```json
{
  "id": "1f0e...",                 // UUID, worker-generated, idempotency key
  "type": "person_detected",
  "camera_id": "f6c1...",
  "ts": "2026-06-23T13:59:01.500Z",
  "confidence": 0.91,              // max person confidence in frame
  "count": 2,                      // persons in frame
  "bboxes": [                      // normalized [0..1], origin top-left
    { "x": 0.10, "y": 0.20, "w": 0.30, "h": 0.55, "conf": 0.91 }
  ],
  "frame_w": 1280, "frame_h": 720,
  "worker_id": "worker-1"
}
```

Everything pushed to the browser is wrapped in one envelope so a single socket
multiplexes everything; the client switches on `channel`:

```json
{ "channel": "alert", "data": { /* detection | stats | state payload */ } }
```

`channel` is one of `alert` · `stats` · `state`. The API filters server-side so a
user only ever receives events for cameras they own.

---

## HTTP API reference

Base URL: `http://localhost:8080`. All routes except `/health` and `/auth/*`
require `Authorization: Bearer <jwt>`.

### Auth

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/auth/signup` | `{ username, password }` (pw ≥ 6) | `201 { token, user }` |
| `POST` | `/auth/login` | `{ username, password }` | `200 { token, user }` |
| `GET` | `/me` | — | `{ id, username }` |
| `GET` | `/health` | — | `{ ok: true }` |

Passwords hashed with `Bun.password` (argon2). JWT carries `sub` (user id) +
`username`.

### Cameras (all JWT-protected, scoped to the owner)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/cameras` | list caller's cameras, newest first |
| `GET` | `/cameras/:id` | one owned camera (404 if not owned/invalid uuid) |
| `POST` | `/cameras` | body `{ name, rtsp_url, location?, enabled? }` → `201` |
| `PATCH` | `/cameras/:id` | partial update of any of the above |
| `DELETE` | `/cameras/:id` | best-effort `stop` first, then deletes (cascades alerts) |
| `POST` | `/cameras/:id/start` | publishes `start`; sets status `connecting` (409 if disabled) |
| `POST` | `/cameras/:id/stop` | publishes `stop`; sets status `stopped` |
| `POST` | `/cameras/:id/webrtc` | body `{ sdp }` (offer) → `{ type:"answer", sdp }` (504 on worker timeout) |

### Alerts

```
GET /alerts?camera_id=<uuid>&from=<iso>&to=<iso>&limit=<1..200>&offset=<n>
```

Always scoped to the caller's cameras (inner join on ownership — you cannot read
another user's alerts even with their `camera_id`). `limit` defaults 50, capped
at 200; `offset` for pagination. Newest first. Returns
`{ alerts, limit, offset, count }`.

---

## WebSocket protocol

```
ws://localhost:8080/ws?token=<jwt>
```

- The JWT is passed as a query param and verified on connect; an invalid/missing
  token closes the socket with code `1008 unauthorized`.
- On success the server sends `{ "channel": "state", "data": { "type": "ws_ready" } }`.
- Thereafter the server pushes `alert` / `stats` / `state` envelopes (see above),
  filtered to the user's cameras.
- One socket per browser session, multiplexed by `channel`.

---

## WebRTC signaling

Signaling is **relayed through the API** rather than run as a separate signaling
server. The browser POSTs its SDP offer; the API forwards it to the worker over
Redis and returns the worker's answer — a request/response (RPC) pattern over
pub/sub keyed by `reqId` (`backend/src/realtime/signaling.ts`):

```
browser --offer--> POST /cameras/:id/webrtc --> API
   API --publish {reqId, sdp}--> redis(webrtc:requests) --> worker
worker --publish {reqId, sdp}--> redis(webrtc:answers) --> API (resolves reqId)
   API --answer--> browser   →   ICE → direct media worker↔browser
```

The API holds the HTTP request open until the matching answer arrives (8s
timeout → `504`). Multiple negotiations run concurrently in the worker so one
slow handshake doesn't block others.

---

## Dedup & rate-limiting

Both live in the worker (`worker/app/dedup.py`), closest to the detection
firehose, so noise never reaches Redis or the DB:

- **Dedup** — a detection is suppressed if the previous emitted detection for the
  same `camera_id` was less than `DEDUP_WINDOW_MS` (default **3000ms**) ago **and**
  the person `count` did not increase. Stops ~25 alerts/sec from one standing
  person; still fires immediately when a *new* person enters.
- **Rate-limit** — hard cap of `MAX_EVENTS_PER_MIN` (default **30**) persisted
  alerts per camera per minute. Excess detections still update live stats but are
  not stored.

Both knobs are env-configurable per the table below.

---

## Running it

**Prerequisites:** Docker + Docker Compose v2 (`docker compose`, not the legacy
`docker-compose`). Linux host recommended — the worker uses host networking for
WebRTC (see the note below). Ports `3000`, `8080`, `5432`, `6379`, `8554` must be
free.

```bash
cp .env.example .env        # defaults work out of the box
docker compose up --build
```

First build is slow — the worker image installs CPU torch + ultralytics. Wait
until the logs settle (`worker up; subscribed to camera:commands, webrtc:requests`).

Then open **http://localhost:3000** and log in with the seeded demo account:

```
username: demo
password: demo12345
```

A demo camera pointing at the looped sample clip is pre-seeded — hit **Start** on
its tile to see live WebRTC video with person boxes, plus alerts and FPS/det-min
updating live. You can also add your own camera (any reachable RTSP URL).

| Service | URL / address |
|---|---|
| Frontend | http://localhost:3000 |
| API | http://localhost:8080 |
| Seeded RTSP source | `rtsp://localhost:8554/cam` (ffmpeg loops `infra/sample/people.mp4`) |

Stop with `Ctrl-C`. `docker compose down` removes containers; add `-v` to also
wipe the Postgres volume (fresh DB + re-seed on next up).

### What comes up (7 containers)

| Container | Port | Role |
|---|---|---|
| `postgres` | 5432 | database (users, cameras, alerts) |
| `redis` | 6379 | pub/sub message bus |
| `mediamtx` | 8554 | RTSP server (fake camera endpoint) |
| `streamer` | — | ffmpeg looping the sample clip into mediamtx |
| `backend` | 8080 | Bun + Hono API + WebSocket |
| `worker` | host net | RTSP → YOLO → WebRTC pipeline |
| `frontend` | 3000 | Next.js dashboard |

### A note on WebRTC + Docker networking

The worker runs with `network_mode: host` **on purpose**: WebRTC needs the
worker's ICE candidates to be addresses the browser can actually reach. On the
host network those are the host's address (the browser is on the same machine),
so media flows. The trade-off is the worker reaches Redis/RTSP via `localhost` +
their published ports — hence the seeded camera URL is `rtsp://localhost:8554/cam`
and the worker's `REDIS_URL`/`API_BASE_URL` point at `localhost`. For a
multi-host deployment you'd add a TURN server and put the worker on the shared
Docker network instead.

---

## Configuration

All via `.env` (copied from `.env.example`). Defaults are dev-ready.

| Variable | Default | Used by | Purpose |
|---|---|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `vms` / `vms_dev_pw` / `vms` | postgres, backend | DB credentials |
| `DATABASE_URL` | `postgres://vms:vms_dev_pw@postgres:5432/vms` | backend | DB connection |
| `REDIS_URL` | `redis://redis:6379` (worker: `redis://localhost:6379`) | backend, worker | message bus |
| `JWT_SECRET` | `change_me_in_prod_please` | backend | JWT signing — **change in prod** |
| `API_PORT` | `8080` | backend | API listen port |
| `WORKER_ID` | `worker-1` | worker | stamped onto detection events |
| `API_BASE_URL` | `http://backend:8080` (worker: `http://localhost:8080`) | worker | API base for the worker |
| `DEDUP_WINDOW_MS` | `3000` | worker | dedup suppression window |
| `MAX_EVENTS_PER_MIN` | `30` | worker | persisted-alert cap per camera/min |
| `MODEL_PATH` | `yolov8n.pt` | worker | detection weights (swap to change model) |
| `CONF_THRESHOLD` | `0.4` | worker | min person confidence to count |
| `DETECT_EVERY_N` | `3` | worker | run YOLO on every Nth frame |
| `STUN_URL` | `stun:stun.l.google.com:19302` | worker | ICE STUN server |
| `NEXT_PUBLIC_API_URL` | `http://localhost:8080` | frontend | API base (browser) |
| `NEXT_PUBLIC_WS_URL` | `ws://localhost:8080/ws` | frontend | WS endpoint (browser) |

---

## Testing

```bash
# backend — jwt unit tests + api integration (integration self-skips without a DB)
cd backend && bun test
DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun test   # full run

# worker — dedup/rate-limit + detection→event mapping (pure logic, no ML deps)
cd worker && python -m unittest discover -s tests -v
```

- **Backend** — `jwt.test.ts` (sign/verify round-trip, tamper rejection) and
  `api.test.ts` (auth flow + ownership-scoped CRUD/alerts against a throwaway
  Postgres; cleanly skips when no DB is reachable so it never blocks CI on
  environments without one).
- **Worker** — `test_dedup.py` (dedup window + rate-limit math) and
  `test_events.py` (detection→event payload shape). Deliberately import-light so
  they run without torch/opencv installed.

The app graph (`backend/src/app.ts`) has **no import-time side effects** (no
server listen, no Redis subscribe), so tests drive it in-process via
`app.fetch(...)` — the server boot lives separately in `index.ts`.

---

## Project layout

```
backend/    Bun + Hono API
  src/
    app.ts            Hono app graph (routes + WS), no side effects — testable
    index.ts          server boot: listen + Redis subscribers
    auth/             jwt sign/verify, middleware, signup/login routes
    cameras/          CRUD + start/stop + webrtc signaling routes
    alerts/           filtered + paginated alert query
    realtime/         redis clients, channels, pub/sub ingest, WS connections,
                      SDP signaling relay
    db/               Drizzle schema + connection
    seed.ts           seeds demo user + demo camera
  test/               jwt unit + api integration
worker/     Python RTSP → YOLO → WebRTC pipeline
  app/
    main.py           Redis command loop; one CameraWorker per camera
    camera_worker.py  per-camera task: RTSP decode + detect + re-stream
    detector.py       YoloDetector (swappable Detector interface)
    dedup.py          DedupRateLimiter
    events.py         detection → event payload mapping
    signaling.py      aiortc offer/answer handling
    config.py         env-driven config
  tests/              dedup + event-format unit tests
frontend/   Next.js dashboard
  app/                login, dashboard, layout
  components/         CameraTile, CameraForm
  lib/                api client, realtime (WS), webrtc, types, config
infra/      mediamtx.yml, sample/people.mp4 (looped RTSP source)
docs/       EVENT_FORMAT.md (the cross-service contract)
docker-compose.yml
```

---

## Design decisions

- **API owns the DB; the worker never touches Postgres.** The worker only speaks
  Redis + HTTP to the API. Keeps the worker stateless and horizontally scalable —
  run N workers, shard cameras across them, no DB contention.
- **WebRTC signaling is relayed through the API**, not a separate signaling
  server — one less moving part, and the SDP handshake reuses the existing
  auth + Redis plumbing.
- **Media never touches the application path.** Only the SDP handshake is relayed;
  the actual H.264 stream is a direct peer connection. The API and Redis stay
  cheap regardless of video resolution or camera count.
- **One WebSocket per browser session**, multiplexed by `channel`, server-side
  filtered to owned cameras. No client-side trust for authorization.
- **Dedup + rate-limit live in the worker** (closest to the firehose) so noise
  never reaches Redis/DB. Both knobs documented and env-tunable.
- **No import-time side effects in the app graph** so the API is testable
  in-process without booting a server or Redis.
- **Optimistic + corrected state.** Start/stop set an immediate optimistic status
  (`connecting`/`stopped`); the worker's `camera_state` events are the source of
  truth and correct the tile (`connecting` → `live`/`error`).

---

## Scaling notes

The architecture is built to scale on camera count, not rewritten for it:

- **Stateless workers.** Worker state lives only in memory for the cameras it
  currently runs; nothing is persisted there. Run N worker replicas and shard
  cameras across them — no coordination needed for correctness.
- **Decoupled via Redis.** API and workers never hold direct sockets to each
  other, so either side can scale or restart independently.
- **Per-camera isolation.** Each camera is its own async task with its own RTSP
  connection and peer connection. One stream failing or being stopped cannot
  affect the others.
- **Media off the hot path.** Because video is peer-to-peer, adding cameras adds
  worker CPU (decode + detect) but barely touches API/Redis load.

What's still needed for true horizontal scale (see Future improvements): a
camera→worker assignment coordinator, a durable queue so detections survive an
API restart, and a TURN server for clients behind restrictive NATs.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Video tile stuck on `connecting` | Worker not on host network, or behind a NAT with no TURN. On Linux confirm `network_mode: host`; STUN-only won't traverse symmetric NAT. |
| `504` from `/cameras/:id/webrtc` | Camera isn't running — hit **Start** first; worker only answers for running cameras. |
| Worker can't reach RTSP/Redis | On host networking the worker uses `localhost` + published ports. Ensure mediamtx (`8554`) and redis (`6379`) ports are published. |
| First detection is slow | CPU YOLO warmup; steadies after a few frames. Raise `DETECT_EVERY_N` to trade recall for throughput. |
| Alerts not appearing live | Check the WS connected (`ws_ready`) and the JWT is valid; an expired token closes the socket with `1008`. |
| Port already in use | Free `3000/8080/5432/6379/8554` or remap in `docker-compose.yml`. |

---

## Future improvements

- Swap Redis pub/sub for a **durable queue** (NATS JetStream / Kafka) so
  detections survive an API restart.
- A **coordinator** that assigns cameras to the least-loaded worker; autoscale on
  camera count (the scalable-architecture bonus).
- **TURN server** for WebRTC across restrictive NATs (currently STUN-only).
- Persist a short **clip / thumbnail** per alert, not just metadata.
- **Kubernetes** manifests + HPA on worker CPU.
- Token **refresh / expiry** handling on the client; currently a single long JWT.
```
