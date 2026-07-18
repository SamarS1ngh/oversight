# M5a — Release Essentials + PWA

**Date:** 2026-07-19
**Milestone:** M5a of the [OSS VMS roadmap](./2026-07-04-oss-vms-product-roadmap.md) — the first public release.
**Goal:** Make Oversight a real, publishable open-source project: an **AGPL-3.0
license**, a **one-command install**, a proper **README**, an installable
**mobile PWA**, and a tagged **v0.1.0 release**.

## Scope

**In:** the `LICENSE` (AGPL-3.0) + a README license section/badge; an `install.sh`
one-command installer that generates secrets and brings the stack up (+ a
`Makefile` of aliases); a rewritten `README.md` (features, quickstart,
architecture, config, license); a mobile PWA (web manifest + icons + a service-
worker fetch handler + responsive polish so the dashboard is usable on a phone);
a version bump to `0.1.0`, a `v0.1.0` git tag, and a GitHub release.

**Out (deferred):** a **desktop launcher** (a Tauri/Electron `.exe`/`.dmg`/
`.AppImage` that double-clicks to run `docker compose up` + opens the dashboard)
— its own future milestone (**M5b desktop launcher**), because it adds per-OS
packaging + code-signing. Also out: `/metrics`, in-UI config settings (a future
**M5c ops** milestone). No product code changes beyond the PWA plumbing +
responsive CSS.

## Decisions locked (from brainstorming)

- **License = AGPL-3.0** — keep Oversight open; a modified network deployment
  must publish its source (blocks closed SaaS forks). Full text in `LICENSE`.
- **Distribution = one-command Docker** (this milestone). A native desktop app
  is deferred (the 5-service architecture — Python ML worker + Postgres + Redis
  + mediamtx — isn't a single binary; a Docker-orchestrating launcher is the
  realistic desktop path, later).
- **PWA, not a native mobile app** — a manifest + icons make the existing
  responsive web dashboard installable + fullscreen on a phone; pairs with the
  M3b web-push notifications.
- **Version `0.1.0`** for the first public release (early but real).

## 1. License (AGPL-3.0)

- `LICENSE` — the verbatim GNU AGPL-3.0 text.
- `README.md` **License** section: a plain-English summary (permissive to use +
  self-host; a *modified* version offered over a network must publish its
  source) + a link to `LICENSE` + an AGPL-3.0 badge.
- Per-file SPDX headers are **out** for v1 (a `LICENSE` file is legally
  sufficient; headers can come later).

## 2. One-command install

### `install.sh` (POSIX-compatible, repo root)
1. Preflight: `docker` + `docker compose` present (else print an install link
   and exit non-zero).
2. If `.env` **does not** exist, create it from `.env.example` and fill fresh
   secrets — **never overwrite an existing `.env`**:
   - `JWT_SECRET` = `openssl rand -hex 32`.
   - VAPID keys = run the existing `backend/scripts/gen-vapid.ts` (via the
     backend image or `bun`), capture the three lines into `.env`.
   - `POSTGRES_PASSWORD` + the `DATABASE_URL` password = a random hex; keep them
     consistent.
   - `SEED_PASS` = a random word/hex; keep `SEED_USER=demo`.
   - Leave `APP_URL`/`PUBLIC_API_URL` at their localhost defaults with a comment
     to change them for a LAN/remote deployment.
3. `docker compose up -d --build`.
4. Print: the dashboard URL (`http://localhost:3000`), the seeded login
   (`demo` / the generated password), and a "change APP_URL for remote access"
   hint.

Idempotent + safe to re-run (skips `.env` generation if present; `up` is
re-entrant).

### `Makefile`
`make install` → `./install.sh`; `make up` / `make down` / `make logs` /
`make ps` → the matching `docker compose` commands. Friendly aliases only.

## 3. README rewrite

A real project README:
- **Title + one-line pitch** ("Oversight — a self-hosted, open-source video
  surveillance system. Real-time detection, recording, rules, and
  notifications, on your own hardware.").
- **Screenshot** — a clearly-marked `docs/screenshot.png` slot referenced from
  the README (a placeholder image committed; the operator drops in a real
  capture). The README must render with the placeholder.
- **Features** — event recording + playback; zone/class rules; object tracking
  (tripwire + dwell); notifications (webhook / ntfy / Telegram / Pushover /
  web-push) with snapshots; auto-reconnect + camera health + offline alerts;
  ONVIF network discovery; a durable Redis-Streams event pipeline.
- **Quickstart** — `git clone … && cd … && ./install.sh`, then open the URL.
- **Architecture** — a mermaid diagram: browser (WebRTC + WS) ↔ backend (Bun/
  Hono) ↔ Postgres + Redis(Streams) ↔ worker (Python/YOLO) ↔ cameras (RTSP/
  ONVIF), with mediamtx as the RTSP server.
- **Configuration** — a table of the key `.env` vars (grouped: core, recording,
  rules, notifications, reliability, streams) with defaults + one-line meanings.
- **Tech stack** + **License** (AGPL-3.0) sections.

## 4. PWA / mobile

- `frontend/public/manifest.webmanifest` — `name: "Oversight"`,
  `short_name: "Oversight"`, `display: "standalone"`, `start_url: "/dashboard"`,
  `theme_color` + `background_color` (match the app's dark theme), and `icons`:
  192×192, 512×512, and a 512×512 **maskable** icon.
- **Icons** — generate a simple placeholder app icon (an eye/lens glyph on the
  theme color) as the three PNGs under `frontend/public/icons/` (replaceable;
  documented in the README). Generation via a committed small script (Node
  canvas or an SVG rasterized with a tool available in the toolchain) or a
  committed static SVG source + generated PNGs.
- **Next root layout** — add `<link rel="manifest" href="/manifest.webmanifest">`
  and a `theme-color` meta (via Next `metadata`/`viewport` exports on the root
  layout).
- **Service worker** — add a minimal `fetch` event listener to the existing
  `frontend/public/sw.js` (M3b's only handles `push`/`notificationclick`; PWA
  installability wants a fetch handler). Keep it a pass-through (network,
  no offline caching in v1) so it can't break live video/WS.
- **Responsive** — audit `globals.css`/the dashboard so the camera-tile grid
  stacks to one column on narrow screens and the top bar/controls are usable on
  a phone (the tiles currently assume a wide grid).

## 5. First release

- Bump the version to `0.1.0` (root `package.json` and/or `frontend`/`backend`
  package manifests — a single source of truth, referenced by the README badge).
- Tag `v0.1.0` and cut a **GitHub release** (`gh release create v0.1.0`) whose
  notes are the feature list + the quickstart. (The controller runs `gh`; if it
  isn't authenticated, the tag is pushed and the release step is documented as a
  manual follow-up rather than blocking.)

## Testing / verification

Verification-heavy (packaging + docs, not unit logic):
- **Install** — from a state with no `.env` (use a temp copy of the repo or move
  `.env` aside), run `install.sh` → it generates a valid `.env` with non-empty
  fresh secrets, `docker compose` comes up healthy, `GET /health` → `{ok:true}`,
  and the seeded `demo` login authenticates. Re-running does not overwrite `.env`.
- **PWA** — `cd frontend && npm run build` stays green; the manifest + icons are
  served; the app is installable (Lighthouse "installable" / a manual
  add-to-home-screen check — the manifest is valid, icons resolve, the SW
  registers with a fetch handler).
- **Responsive** — the dashboard renders as a single stacked column at a phone
  width (a manual/DevTools check; no layout overflow).
- **Docs** — `LICENSE` is the AGPL-3.0 text; the README renders with the
  placeholder screenshot; internal links resolve; the version/badge match the
  tag.
- No existing test suite should regress: backend `bun test`, worker
  `python3 -m pytest`, frontend `npm run build` all stay green (this milestone
  touches packaging/docs/PWA, not service logic).

## Rollout / definition of done

A fresh `git clone` + `./install.sh` brings the whole stack up in one command
with auto-generated secrets and prints a working login; the dashboard is
installable as an app on a phone (icon, fullscreen) and usable at phone width;
`LICENSE` is AGPL-3.0 and the README documents features + quickstart +
architecture + license; the repo is tagged `v0.1.0` with a GitHub release.
Oversight is publishable.
