# Product Roadmap — Self-Hosted OSS VMS

**Date:** 2026-07-04
**Direction:** Self-hosted, open-source Video Management System (VMS). Users run it
on their own hardware (NAS / mini-PC / homelab box); their video never leaves
their building. Free and open-source. Benchmark: [Frigate](https://github.com/blakeshome/frigate).

## Where we start

An existing working demo: JWT auth, camera CRUD, live WebRTC video, YOLOv8n
person detection, real-time alerts over WebSocket, Redis pub/sub, Dockerized.
Clean service boundaries (API owns DB; stateless Python worker; media off the hot
path). It works end to end but is **live-view only** — nothing is recorded, alerts
are metadata that die in the browser, and detection is a single rule ("a person
exists").

## What "product" means for this direction

Kill the gaps that don't matter for self-hosting (billing, multi-tenant/RBAC,
TURN, K8s, compliance). Build the gaps that do, in dependency order.

## Milestones (each gets its own spec → plan → build cycle)

| # | Milestone | Adds | Depends on |
|---|---|---|---|
| **M1** | Recording & Playback | Event-clips to disk, retention, thumbnails, alert→clip link, timeline/events UI, clip export | — |
| **M2** | Smart detection / rules engine | Zones (polygon), tripwire line-cross, multi-class, dwell/loiter, schedules, severity, ack/resolve | M1 (clips give the "what happened") |
| **M3** | Notifications | Web push / ntfy / Telegram / Pushover / email / webhook, **with clip + thumbnail** | M1 (clip to attach), M2 (rule to filter) |
| **M4** | Camera lifecycle + reliability | ONVIF/RTSP auto-discovery, reconnect/backoff, offline/health detection, durable event store | — (parallel-able, but sequenced after value features) |
| **M5** | Deploy + release polish | One-line install, config UI, mobile PWA, basic metrics, license + docs + demo, first public release | M1–M4 |

**Build order is fixed by dependencies:** M1 → M2 → M3 → M4 → M5. We design and
build one milestone at a time so each ships working.

## Explicitly out of scope (this direction)

Billing / plans / quotas · multi-tenant orgs & RBAC · TURN server · Kubernetes /
autoscale · GDPR/compliance tooling · cloud-hosted storage as default (S3 stays an
optional pluggable backend, local disk is the default).

## North star

"An open-source Frigate alternative you bring up with one command, that records
what matters, gets smart about what it alerts on, and pushes those alerts to your
phone with a clip attached — all on your own hardware."
