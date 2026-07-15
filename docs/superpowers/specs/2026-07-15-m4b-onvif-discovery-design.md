# M4b — ONVIF Camera Auto-Discovery

**Date:** 2026-07-15
**Milestone:** M4b of the [OSS VMS roadmap](./2026-07-04-oss-vms-product-roadmap.md)
**Goal:** Stop making users hand-type RTSP URLs. A "Scan network" action finds
ONVIF cameras on the LAN, asks each one (with credentials) for its real RTSP
stream URL, and streams the discovered cameras back to the browser with a
one-click **Add** that prefills the add-camera form.

## Scope

**In:** worker-side ONVIF discovery (WS-Discovery multicast → per-device
`GetDeviceInformation` + Media `GetStreamUri`); a `discover` worker command; a
`POST /discovery/scan` backend endpoint that dispatches the scan and relays
results over the existing WebSocket; a "Scan network" UI (credentials modal →
live discovered-camera list → Add prefills the existing form). One credential
set per scan.

**Out:** persisting scan results (transient, streamed only); per-device
distinct credentials (one set per scan); auto-adding cameras (user confirms
each); an emulated ONVIF device in the docker stack (real-camera scan is manual
verification — see Testing). Non-ONVIF cameras (pure RTSP with no ONVIF) are not
auto-discovered — the manual add form remains.

## Decisions locked (from brainstorming)

- **Full ONVIF auto-fill:** WS-Discovery finds devices, then ONVIF Media
  `GetStreamUri` returns the actual RTSP URL. Not a port scan, not
  find-devices-only.
- **Discovery runs in the worker** (`network_mode: host` → LAN multicast
  reachable). The backend (bridge net) cannot multicast the LAN.
- **One credential set per scan:** the scan form has a username + password used
  for every discovered device's `GetStreamUri`. A device where auth/media fails
  still lists (name + IP) with an `error`, no URL.
- **Results stream over the existing WebSocket** (worker → Redis → backend →
  `sendToUser`), the same relay path as detections/stats. No new transport, no
  results table.
- **User confirms each add** (no auto-add). Add prefills the existing
  add-camera form with `{ name, rtsp_url }`.

## Architecture

```
UI "Scan network" (username, password)
  → POST /discovery/scan (authed)
        publish {type:"discover", scan_id, user_id, username, password} → redis camera:commands
        return { scan_id }
  worker handle_command("discover"):
        WS-Discovery multicast (239.255.255.250:3702) → ONVIF device service URLs
        per device: GetDeviceInformation → name/model; Media GetStreamUri(creds) → rtsp_url (or error)
        publish {scan_id, user_id, cameras:[...]} → redis discovery:results
  backend ingest subscribes discovery:results → sendToUser(user_id, {channel:"discovery", data})
  UI (WS "discovery" channel): render discovered cameras; Add → prefill add-camera form → POST /cameras
```

## Worker

### `worker/app/discovery.py`
`discover_onvif(username, password, timeout_s, *, probe=..., onvif_factory=...) ->
list[dict]` — each dict: `{ name, ip, hardware, rtsp_url: str|None, error: str|None }`.
- **WS-Discovery** (the `wsdiscovery` lib): send a `Probe` for
  `NetworkVideoTransmitter`; collect `ProbeMatch` device service XAddrs (URLs)
  within `timeout_s`; extract each device IP.
- Per device, build an ONVIF client (the `onvif-zeep` lib) with the scan creds:
  - `GetDeviceInformation` → `name` = `"<Manufacturer> <Model>"`.
  - `create_media_service().GetStreamUri(...)` → `rtsp_url`. On failure (auth,
    no media profile, timeout) → `error = str(e)[:160]`, `rtsp_url = None`.
- The network primitives (`probe`, `onvif_factory`) are **injectable** so the
  mapping logic is host-testable without real cameras or the libs.
- Dependency-light import: `wsdiscovery`/`onvif` imported inside the function
  (like the worker's other heavy imports) so the pure tests import the module
  without the libs installed.

### Command handler (`worker/app/main.py`)
`handle_command`: on `type == "discover"`, run `discover_onvif(cmd.username,
cmd.password, DISCOVERY_TIMEOUT_S)` and `publish("discovery:results", {scan_id,
user_id, cameras})`. Wrapped so a scan failure publishes
`{scan_id, user_id, cameras: [], error}` rather than crashing the worker loop.
Config: `DISCOVERY_TIMEOUT_S` (default 5).

## Backend

### `backend/src/discovery/routes.ts` (mounted `/discovery`)
- `POST /discovery/scan` (auth required): body `{ username, password }`
  (username/password strings; password may be empty). Generate `scan_id`
  (uuid), publish `{ type: "discover", scan_id, user_id: <caller>, username,
  password }` to the `camera:commands` Redis channel via the existing publisher.
  Return `{ scan_id }`. No persistence.

### `backend/src/realtime/ingest.ts`
Subscribe to `discovery:results` alongside the existing channels. On a message,
`sendToUser(msg.user_id, { channel: "discovery", data: msg })`. Non-blocking,
best-effort (same envelope as the other relays).

## Frontend

- `lib/types.ts`: `DiscoveredCamera = { name: string; ip: string; hardware?:
  string; rtsp_url: string | null; error: string | null }`.
- `lib/api.ts`: `scanNetwork(username, password)` → `POST /discovery/scan`.
- `lib/realtime.ts`: handle the `discovery` WS channel → accumulate discovered
  cameras into state exposed by the hook.
- A **"Scan network"** button on the dashboard opens a modal: username +
  password + **Scan**. On submit, call `scanNetwork`, then show a spinner and
  render discovered cameras as they stream in (name, IP, hardware; the RTSP URL
  or a muted "needs credentials / not ONVIF" note when `error`). Each row has
  **Add** → opens the existing add-camera form prefilled with `{ name, rtsp_url
  }`. Cameras whose `rtsp_url`/IP already matches an existing camera are marked
  "already added" and their Add is disabled.

## Security

The scan credentials travel UI → backend → Redis (internal) → worker; the
returned RTSP URL may embed credentials (`rtsp://user:pass@ip/...`) and is stored
as-is in `cameras.rtspUrl` (unchanged from today's manual entry — acceptable for
single-user self-hosted). Credentials are never persisted server-side beyond the
transient scan command. The scan endpoint is auth-gated; discovery is confined
to the worker's own LAN.

## Backward compatibility

Purely additive: a new endpoint, a new worker command, a new WS channel, a new
UI entry point. The manual add-camera form is unchanged (and remains the path
for non-ONVIF cameras). No schema changes.

## Testing

- **Worker unit (host-testable, no libs/network):** `discover_onvif` with an
  injected `probe` returning fake device XAddrs and an injected `onvif_factory`
  returning a stub client — assert the device→`{name, ip, rtsp_url}` mapping;
  a stub whose `GetStreamUri` raises → `error` set, `rtsp_url` None, no crash;
  an empty probe → `[]`.
- **Backend (integration):** `POST /discovery/scan` requires auth (401
  unauth'd), and publishes a `discover` command carrying the caller's `user_id`
  + a `scan_id` (assert against a captured/mock publisher); the ingest relay
  maps a `discovery:results` Redis message to `sendToUser(user_id, {channel:
  "discovery", ...})` (unit-test the relay handler with a fake `sendToUser`).
- **Frontend:** `npm run build`; the scan modal renders; Add prefills the form.
- **Manual (real ONVIF camera — documented, not CI):** on a LAN with a real
  ONVIF camera, Scan network with valid creds → the camera appears with its
  RTSP URL → Add → it starts and goes live. This is the only true end-to-end
  check; the docker stack has no ONVIF device, so CI relies on the mocked unit
  tests above.

## Rollout / definition of done

`docker compose up`. Click **Scan network**, enter camera credentials, Scan.
Discovered ONVIF cameras stream into the list with prefilled RTSP URLs (or a
clear "needs credentials" note); clicking **Add** on one opens the add form
prefilled, and after confirming, the camera starts and (per M4a) reconnects/
reports health normally. Cameras already added are marked as such. A scan on a
network with no ONVIF cameras completes cleanly with an empty result. (The real
end-to-end path is verified manually against an actual ONVIF camera; CI covers
the discovery mapping + relay via mocks.)
