# M5a Release Essentials + PWA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Oversight publishable — AGPL-3.0 license, a one-command install, a real README, an installable mobile PWA, and a tagged v0.1.0 release.

**Architecture:** Packaging + docs + PWA plumbing, not service logic. `install.sh` generates secrets (openssl) and runs `docker compose up`; a `Makefile` wraps common commands; the README documents features/quickstart/architecture; a web manifest + icons + a service-worker fetch handler + responsive CSS make the existing dashboard an installable phone app.

**Tech Stack:** bash + openssl + Docker Compose (install); Markdown + mermaid (docs); Next.js/React manifest + a service worker (PWA); `gh` (release).

## Global Constraints

- **License = AGPL-3.0** (verbatim canonical text in `LICENSE`).
- **`install.sh` is toolchain-light** — only `docker`, `docker compose`, and `openssl` (with a `/dev/urandom` fallback). It generates `JWT_SECRET`, the Postgres password (kept consistent in `DATABASE_URL`), and `SEED_PASS`; it **leaves VAPID empty** (web push is inert without it) with a documented `make vapid` follow-up. It **never overwrites an existing `.env`** and is safe to re-run.
- **No service-logic changes** — only packaging, docs, the PWA manifest/SW/layout, and responsive CSS. Existing suites must stay green (backend `bun test`, worker `python3 -m pytest`, frontend `npm run build`).
- **PWA service worker stays a pass-through** — a `fetch` listener that does not cache (no offline caching in v1), so it can't break live WebRTC/WS.
- **Commits:** author Samar only, NO `Co-Authored-By: Claude` trailer. `git add` explicit paths only (untracked `docs/CODE_WALKTHROUGH.md` — never commit it).
- Version is already `0.1.0` in `frontend/package.json` + `backend/package.json` — no bump needed; the release just tags `v0.1.0`.

---

### Task 1: LICENSE (AGPL-3.0)

**Files:**
- Create: `LICENSE`

- [ ] **Step 1: Fetch the canonical AGPL-3.0 text**

Run: `curl -fsSL https://www.gnu.org/licenses/agpl-3.0.txt -o LICENSE`
If the network is unavailable, write the verbatim GNU Affero General Public License v3.0 text instead (from a known-good copy).

- [ ] **Step 2: Verify**

Run: `head -1 LICENSE && wc -l LICENSE`
Expected: first line contains `GNU AFFERO GENERAL PUBLIC LICENSE`; the file is the full license (~660 lines / ~34 KB). Confirm it mentions `Version 3` and the AGPL "network use" clause (`grep -c "network" LICENSE` ≥ 1).

- [ ] **Step 3: Commit**

```bash
git add LICENSE
git commit -m "chore: add AGPL-3.0 LICENSE"
```

---

### Task 2: One-command install (`install.sh` + `Makefile`)

**Files:**
- Create: `install.sh` (repo root, `chmod +x`)
- Create: `Makefile` (repo root)

- [ ] **Step 1: Write `install.sh`**

```bash
#!/usr/bin/env bash
# Oversight one-command installer: generate secrets + bring the stack up.
set -euo pipefail
cd "$(dirname "$0")"

command -v docker >/dev/null || { echo "Docker is required: https://docs.docker.com/get-docker/"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is required (docker compose)."; exit 1; }

rand() { # 32-byte hex; openssl if present, else /dev/urandom
  if command -v openssl >/dev/null; then openssl rand -hex 32
  else head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

if [ ! -f .env ]; then
  echo "Generating .env with fresh secrets..."
  cp .env.example .env
  JWT="$(rand)"; PGPW="$(rand | cut -c1-24)"; SEEDPW="$(rand | cut -c1-16)"
  # portable in-place sed (GNU + BSD)
  sedi() { if sed --version >/dev/null 2>&1; then sed -i "$1" .env; else sed -i '' "$1" .env; fi; }
  sedi "s|^JWT_SECRET=.*|JWT_SECRET=${JWT}|"
  sedi "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${PGPW}|"
  sedi "s|^DATABASE_URL=.*|DATABASE_URL=postgres://vms:${PGPW}@postgres:5432/vms|"
  sedi "s|^SEED_PASS=.*|SEED_PASS=${SEEDPW}|"
  echo "  JWT_SECRET, POSTGRES_PASSWORD, SEED_PASS generated. VAPID left empty (run 'make vapid' to enable web push)."
else
  echo ".env already exists — leaving it untouched."
  SEEDPW="$(grep -E '^SEED_PASS=' .env | cut -d= -f2-)"
fi

echo "Building + starting the stack..."
docker compose up -d --build

echo ""
echo "Oversight is up:  http://localhost:3000"
echo "Login:            demo / ${SEEDPW:-<see SEED_PASS in .env>}"
echo "For LAN/remote access, set APP_URL + PUBLIC_API_URL in .env and re-run 'make up'."
```
**Required `.env.example` edit:** `.env.example` currently has `JWT_SECRET`, `POSTGRES_PASSWORD`, `DATABASE_URL` but **no `SEED_USER`/`SEED_PASS`** — so install.sh's `sed s|^SEED_PASS=...|` has no line to replace. Add these two lines to `.env.example` (backend section) so the installer can fill them:
```
SEED_USER=demo
SEED_PASS=demo12345
```
Then `chmod +x install.sh`.

- [ ] **Step 2: Write `Makefile`**

```makefile
.PHONY: install up down logs ps vapid
install: ; ./install.sh
up: ; docker compose up -d --build
down: ; docker compose down
logs: ; docker compose logs -f --tail=100
ps: ; docker compose ps
vapid: ## generate VAPID keys into .env (enables web push)
	@docker compose run --rm --no-deps --entrypoint "" backend bun run scripts/gen-vapid.ts | \
	  while IFS= read -r line; do \
	    key=$${line%%=*}; sed -i.bak "s|^$$key=.*|$$line|" .env && rm -f .env.bak; \
	  done; echo "VAPID keys written to .env — run 'make up' to apply."
```
(Tabs, not spaces, in the recipe lines. The `vapid` target runs the existing `backend/scripts/gen-vapid.ts` inside the backend image and writes the three lines into `.env`.)

- [ ] **Step 3: Shellcheck-lint + syntax**

Run: `bash -n install.sh` (parses OK). If `shellcheck` is available, `shellcheck install.sh` (no errors; warnings acceptable). Confirm `install.sh` is executable (`test -x install.sh`).

- [ ] **Step 4: Commit**

```bash
git add install.sh Makefile .env.example
git commit -m "feat: one-command install.sh + Makefile"
```

---

### Task 3: README rewrite

**Files:**
- Modify: `README.md`
- Create: `docs/screenshot.png` (a committed placeholder image)

- [ ] **Step 1: Placeholder screenshot**

Create a small placeholder `docs/screenshot.png` (any valid PNG — e.g. a 1200×750 solid dark image with the text "Oversight — screenshot"; generate with `sharp` or a tiny script, or commit a minimal valid PNG). It only needs to render; the operator replaces it later.

- [ ] **Step 2: Rewrite `README.md`**

Structure (replace the existing content):
- `# Oversight` + one-line pitch: *"A self-hosted, open-source video surveillance system — real-time detection, recording, rules, and notifications, on your own hardware."*
- An AGPL-3.0 badge line + `![screenshot](docs/screenshot.png)`.
- **Features** (bulleted): event recording + playback; zone & class rules; object tracking (tripwire + dwell); notifications — webhook / ntfy / Telegram / Pushover / web-push, with detection snapshots; auto-reconnect + camera health + offline alerts; ONVIF network discovery; a durable Redis-Streams event pipeline.
- **Quickstart**:
  ```bash
  git clone <repo-url> oversight && cd oversight
  ./install.sh
  # open http://localhost:3000  (login printed by the installer)
  ```
- **Architecture** — a mermaid block:
  ```mermaid
  flowchart LR
    B[Browser<br/>Next.js PWA] <-->|WebRTC + WS| API[Backend<br/>Bun/Hono]
    API <--> PG[(Postgres)]
    API <-->|Redis Streams| R[(Redis)]
    W[Worker<br/>Python/YOLO] -->|events| R
    R --> API
    CAM[Cameras<br/>RTSP/ONVIF] --> MM[mediamtx] --> W
  ```
- **Configuration** — a table of the key `.env` vars grouped (core: JWT_SECRET/APP_URL/PUBLIC_API_URL; recording: PRE_ROLL_S/POST_ROLL_S/RETENTION_DAYS; reliability: OFFLINE_GRACE_S/STALL_TIMEOUT_S; notifications: VAPID_*; streams: STREAM_MAXLEN/MAX_DELIVERIES) with defaults + one-line meanings.
- **Tech stack**: Next.js/React, Bun/Hono, Drizzle/Postgres, Redis Streams, Python/PyAV/OpenCV/YOLOv8/ByteTrack, mediamtx, WebRTC.
- **License**: AGPL-3.0 — plain-English note (free to use + self-host; a *modified* version offered over a network must publish its source) + link to `LICENSE`.

- [ ] **Step 3: Verify it renders**

Run: `grep -c "mermaid" README.md` (≥1); confirm `docs/screenshot.png` exists (`test -f docs/screenshot.png`) and the README references it. Optionally `npx --yes markdown-link-check README.md` for internal links (best-effort).

- [ ] **Step 4: Commit**

```bash
git add README.md docs/screenshot.png
git commit -m "docs: rewrite README (features, quickstart, architecture, license)"
```

---

### Task 4: PWA — manifest + icons + wiring

**Files:**
- Create: `frontend/public/manifest.webmanifest`
- Create: `frontend/public/icons/icon-192.png`, `icon-512.png`, `icon-512-maskable.png`
- Create: `frontend/public/icons/icon.svg` (the source glyph)
- Modify: `frontend/app/layout.tsx` (manifest link + theme-color + title)
- Modify: `frontend/public/sw.js` (fetch handler)

- [ ] **Step 1: Icon source + PNGs**

Create `frontend/public/icons/icon.svg` — a simple app glyph (e.g. a camera-lens / eye: a filled rounded square in the theme color `#0d1117` with a light circle/lens). Rasterize to the three PNGs. Prefer `sharp` (Next bundles it): a small Node script, e.g.
```bash
cd frontend
node -e "const sharp=require('sharp');const s='public/icons/icon.svg';(async()=>{for(const[o,sz] of [['public/icons/icon-192.png',192],['public/icons/icon-512.png',512],['public/icons/icon-512-maskable.png',512]]){await sharp(s).resize(sz,sz).png().toFile(o);}})()"
```
If `sharp` isn't resolvable, use `npx --yes @resvg/resvg-js-cli` or `npx --yes sharp-cli`; if all rasterizers fail, reference the SVG directly in the manifest (Chrome accepts SVG icons) and note PNG generation as a follow-up. Confirm the PNGs are non-empty (`file` shows PNG, size > 0).

- [ ] **Step 2: `manifest.webmanifest`**

```json
{
  "name": "Oversight",
  "short_name": "Oversight",
  "description": "Self-hosted video surveillance",
  "start_url": "/dashboard",
  "display": "standalone",
  "background_color": "#0d1117",
  "theme_color": "#0d1117",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icons/icon-512-maskable.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```
(Use the app's actual dark theme color if it differs from `#0d1117` — check `globals.css`.)

- [ ] **Step 3: Layout wiring**

In `frontend/app/layout.tsx`, update `metadata` and add a `viewport` export (Next 15):
```ts
export const metadata: Metadata = {
  title: "Oversight",
  description: "Self-hosted, open-source video surveillance",
  manifest: "/manifest.webmanifest",
};
export const viewport = { themeColor: "#0d1117" };
```
(Import `Viewport` type if annotating. Next serves `/manifest.webmanifest` from `public/`. Also add `<meta name="apple-mobile-web-app-capable" content="yes">` via `metadata.appleWebApp = { capable: true, title: "Oversight" }` for iOS standalone.)

- [ ] **Step 4: Service-worker fetch handler**

In `frontend/public/sw.js`, add a pass-through `fetch` listener (installability needs one; no caching so it can't break live video/WS):
```js
// Pass-through fetch (no offline caching in v1) — required for PWA installability.
self.addEventListener("fetch", () => {});
```
(An empty `fetch` handler satisfies the installability requirement without intercepting responses. Keep the existing `push`/`notificationclick` handlers.)

- [ ] **Step 5: Build**

Run: `cd frontend && npm run build`
Expected: compiles; `/manifest.webmanifest` + `/icons/*` are in `public/` (served as static). No type errors from the layout changes.

- [ ] **Step 6: Commit**

```bash
git add frontend/public/manifest.webmanifest frontend/public/icons frontend/app/layout.tsx frontend/public/sw.js
git commit -m "feat(web): installable PWA (manifest, icons, theme, SW fetch handler)"
```

---

### Task 5: Responsive dashboard (phone width)

**Files:**
- Modify: `frontend/app/globals.css`

**Interfaces:**
- The camera-tile grid currently `grid-template-columns: repeat(auto-fill, minmax(330px, 1fr))` (`globals.css:148`) — a 330px min forces horizontal overflow below 330px and cramped layout on phones.

- [ ] **Step 1: Add a narrow-screen breakpoint**

In `frontend/app/globals.css`, add (near the tile/dash rules) a media query so the grid stacks and the top bar wraps on phones:
```css
@media (max-width: 560px) {
  .tiles { grid-template-columns: 1fr; }          /* one column, no 330px overflow */
  .topbar { flex-wrap: wrap; gap: 8px; }
  .top-actions { flex-wrap: wrap; }
  .stats { flex-wrap: wrap; }
}
```
(Match the actual class names used by the dashboard/tiles — grep `globals.css` + `CameraTile.tsx`/`dashboard/page.tsx` for the real selectors: `.tiles`, `.topbar`, `.top-actions`, `.stats`, `.dash`. Adjust the query to the real names; the goal is: single-column tiles + wrapping controls at phone width, no horizontal scroll.)

- [ ] **Step 2: Verify**

Run: `cd frontend && npm run build` (compiles). Manual/DevTools check at 390px width: tiles stack to one column, no horizontal overflow, controls reachable. (No automated viewport test; the build + a described manual check is the gate.)

- [ ] **Step 3: Commit**

```bash
git add frontend/app/globals.css
git commit -m "feat(web): responsive dashboard — single-column tiles on phones"
```

---

### Task 6: Verification + v0.1.0 release

**Files:**
- (No new files; verification + tag/release.)

- [ ] **Step 1: Full-clone install e2e — CONTROLLER runs**

The controller: with `.env` moved aside (`mv .env /tmp/env.bak`), runs `./install.sh` → confirms it generates a `.env` with non-empty `JWT_SECRET`/`POSTGRES_PASSWORD`/`SEED_PASS`, the stack comes up, `curl -s localhost:8080/health` → `{"ok":true}`, and the printed `demo` login authenticates (`POST /auth/login`). Confirms re-running `install.sh` does NOT overwrite `.env`. Then restores the original `.env` + `docker compose up -d` to reconcile.

- [ ] **Step 2: Suites + PWA — CONTROLLER runs**

Backend `bun test`, worker `python3 -m pytest`, frontend `npm run build` all green (no regressions). The manifest + icons are served; a build-time check that `/manifest.webmanifest` is valid JSON + the icon files exist. PWA installability + phone-width layout are a manual/Lighthouse check the controller notes.

- [ ] **Step 3: Tag + GitHub release — CONTROLLER runs**

On `main` after merge (or on the branch, coordinated): `git tag v0.1.0` + `git push origin v0.1.0`; `gh release create v0.1.0 --title "Oversight v0.1.0" --notes "<feature list + quickstart>"`. If `gh` is unauthenticated, push the tag and document the release step as a manual follow-up (do not block).

- [ ] **Step 4: Commit (docs note only, if any)**

No code commit required for verification. If a `CHANGELOG.md` is desired, add it here with the v0.1.0 feature list and commit; otherwise skip.

---

## Notes for the executor

- `install.sh` must be **idempotent + never clobber `.env`** — the single most important property (a re-run must not regenerate secrets and break a running deployment).
- Keep the SW `fetch` handler a **no-op pass-through** — do NOT add caching; caching live MJPEG/WebRTC/WS would break the live view.
- No service-logic changes in this milestone — if a task seems to require touching backend/worker logic, stop and flag it.
- Icon rasterization is best-effort across tools (`sharp` → `npx` fallbacks → SVG-in-manifest) — a working installable manifest with valid icons is the bar, not a specific tool.
- The AGPL text must be the **verbatim canonical** license — fetch it, don't paraphrase.
