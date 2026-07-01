# Oversight — Real-Time Camera Surveillance Dashboard

Register cameras by RTSP URL, watch the live feed in your browser over **WebRTC**,
and get **real-time person-detection alerts** the instant someone walks into
frame — no page refresh.

It's a small Video Management System (VMS): a Next.js dashboard, a Bun API, and a
Python worker that ingests RTSP, runs **YOLOv8n** person detection, and re-streams
the annotated video to the browser. Postgres stores users/cameras/alerts; Redis is
the message bus. Everything runs with one `docker compose up`.

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
