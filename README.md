# Oversight — Real-Time Camera Surveillance Dashboard

Register cameras by RTSP URL, watch the live feed in your browser over **WebRTC**,
and get **real-time person-detection alerts** the instant someone walks into
frame — no page refresh.

It's a small Video Management System (VMS): a Next.js dashboard, a Bun API, and a
Python worker that ingests RTSP, runs **YOLOv8n** person detection, and re-streams
the annotated video to the browser. Postgres stores users/cameras/alerts; Redis is
the message bus. Everything runs with one `docker compose up`.

Event clips are now recorded on detection (with a few seconds of pre-roll) and
served from `/clips` — each alert links to a short **video clip + thumbnail**,
also browsable in **Recordings**.

![Live person detection with bounding box](docs/screenshots/03-live-detection.png)

| Dashboard | Live WebRTC stream |
|---|---|
| ![Dashboard](docs/screenshots/01-dashboard.png) | ![Live stream](docs/screenshots/02-live-stream.png) |

---

## Download

```bash
git clone https://github.com/SamarS1ngh/oversight.git
cd oversight
```

Or grab a ZIP from the [GitHub repo](https://github.com/SamarS1ngh/oversight)
("Code" → "Download ZIP") and unzip it.

---

## Setup

**Prerequisites:**

- Docker + Docker Compose v2 (`docker compose`, not the legacy `docker-compose`)
- Linux host recommended — the worker uses host networking for WebRTC
- Free ports: `3000`, `8080`, `5432`, `6379`, `8554`

Copy the environment file (defaults work out of the box):

```bash
cp .env.example .env
```

---

## Configuration

Selected env vars (see [`.env.example`](.env.example) for the full list) — the
recording knobs added for the clip/thumbnail feature, plus rules-engine settings:

| Variable | Default | Used by | Purpose |
|---|---|---|---|
| `PRE_ROLL_S` | `10` | worker | seconds of footage kept before a trigger |
| `POST_ROLL_S` | `10` | worker | seconds recorded after the last trigger |
| `MAX_CLIP_LEN_S` | `120` | worker | hard cap on a single (extended) clip |
| `RECORDINGS_DIR` | `/recordings` | worker, backend | clip/thumbnail storage root (shared volume) |
| `STORAGE_BACKEND` | `local` | worker | clip storage backend |
| `RETENTION_DAYS` | `7` | backend | delete clips older than this |
| `MAX_STORAGE_GB` | `10` | backend | evict oldest clips past this total |
| `MODEL_CLASSES` | `person,bicycle,car,motorcycle,bus,truck,cat,dog,backpack,handbag,suitcase` | worker | comma-separated YOLO detection classes |
| `TZ` | `UTC` | worker | timezone for schedule windows in alert rules |

**Rules & Zones:** cameras now support drawing zones and creating alert rules. Presence rules detect when objects enter a zone; tripwire rules detect line-crossing; dwell rules detect loitering. The worker uses **ByteTrack** (`supervision`) for multi-object tracking across frames to power tripwire and dwell detection.

**Durable Event Pipeline (M4c):** detections and clips are now delivered via **Redis Streams** (`stream:detections` and `stream:clips`). A backend or Redis restart does not lose these events — the consumer group `vms-backend` replays entries that were written while the backend was offline. Redis persists with AOF (append-only file) enabled, ensuring durability across container restarts.

**Notifications (M3b):** alerts are delivered to **webhook**, **ntfy**, **Telegram**, **Pushover**, and **web push** channels (configured under **Notifications** in the dashboard). All notification payloads include a snapshot image from the detection frame — uploaded directly to ntfy/Telegram/Pushover services, or embedded as a signed URL (reachable via token auth) for webhook and web-push clients. Web push requires VAPID keys (set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` in `.env` — generate them with `bun run backend/scripts/gen-vapid.ts`) and works on HTTPS or `localhost` (service worker requirement). Failed notification sends are automatically retried by a background queue; delivery status is tracked in the `notification_deliveries` table.

**Camera Health (M4a):** cameras automatically reconnect with exponential backoff when the stream stalls or fails. A camera is marked `offline` after `OFFLINE_GRACE_S` of no frames. Each camera card displays its reconnecting/offline status, time since last frame, and reconnect count. Enable the per-camera **Notify if offline** toggle to send offline/recovery notifications via your configured M3 channels.

**ONVIF Discovery (M4b):** the dashboard includes a **Scan network** button that discovers ONVIF cameras on your local area network and auto-prefills the RTSP URL for each discovered device. Provide one credential set per scan; the worker broadcasts a multicast query and collects device descriptions. Non-ONVIF cameras can still be added manually via the **+ Add Camera** form. Discovery runs asynchronously in the worker; results are pushed to the UI over WebSocket.

---

## Run

```bash
docker compose up --build
```

First build is slow — the worker image installs CPU-only PyTorch + ultralytics.
Wait until the logs settle on `worker up; subscribed to camera:commands, webrtc:requests`.

Then open **http://localhost:3000** and log in with the seeded demo account:

```
username: demo
password: demo12345
```

A demo camera pointing at a looped sample clip is pre-seeded — hit **Start** on
its tile to see live WebRTC video with person boxes, plus alerts and FPS /
detections-per-minute updating live. You can also add your own camera with any
reachable RTSP URL.

| Service | URL |
|---|---|
| Dashboard | http://localhost:3000 |
| API | http://localhost:8080 |
| Seeded RTSP source | `rtsp://localhost:8554/cam` |

**Stop:** `Ctrl-C`. Run `docker compose down` to remove containers, or
`docker compose down -v` to also wipe the database (fresh DB + re-seed next run).
