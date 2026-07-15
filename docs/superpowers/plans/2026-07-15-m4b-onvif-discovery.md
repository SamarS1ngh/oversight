# M4b ONVIF Camera Auto-Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Scan network" action finds ONVIF cameras on the LAN, resolves each one's RTSP URL via ONVIF (with credentials), and streams them to the browser with a one-click Add that prefills the add-camera form.

**Architecture:** Discovery runs in the worker (`network_mode: host` → LAN multicast). `POST /discovery/scan` publishes a `discover` command on the existing `camera:commands` Redis channel; the worker runs WS-Discovery + ONVIF `GetStreamUri` and publishes results to `discovery:results`; the backend relays them to the requesting user over the existing WebSocket (`discovery` channel). Results are transient (no persistence).

**Tech Stack:** Python worker (`WSDiscovery`, `onvif-zeep`); Bun + Hono backend; Next.js/React frontend; Redis pub/sub + the existing WS relay.

## Global Constraints

- **Discovery runs in the worker only** (host-net multicast). The backend never scans.
- **One credential set per scan** — used for every device's `GetStreamUri`. A device where auth/media fails still lists (name + IP) with `error` set, `rtsp_url` None.
- **Results stream over the existing WS** (worker → Redis `discovery:results` → backend `sendToUser(user_id, {channel:"discovery"})`). No results table.
- **Non-blocking / crash-safe:** a scan failure publishes an empty result with an `error`, never crashes the worker command loop; the backend relay never throws into ingest.
- **User confirms each add** — Add prefills the existing add-camera form; no auto-add. Additive: no schema changes.
- **Commits:** author Samar only, NO `Co-Authored-By: Claude` trailer. `git add` explicit paths only (an untracked `docs/CODE_WALKTHROUGH.md` exists — never commit it).
- **Test envs:** host `python3` runs ONLY pure worker modules — `discovery.py`'s network primitives are INJECTED so it's host-testable WITHOUT `WSDiscovery`/`onvif` installed; never import `camera_worker`/`main` in a host test. `python3 -m pytest`. Backend: `RECORDINGS_DIR=/tmp/vms-rec DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun test`; tsc gate `bunx tsc --noEmit` → 0. The real ONVIF multicast is NOT CI-testable (no ONVIF device in the stack) — verified manually.

---

### Task 1: Worker ONVIF discovery core (pure, TDD)

**Files:**
- Create: `worker/app/discovery.py`
- Test: `worker/tests/test_discovery.py`

**Interfaces:**
- Produces: `discover_onvif(username, password, timeout_s=5, *, probe=_default_probe, onvif_factory=_default_onvif_factory) -> list[dict]`, each dict `{ name, ip, hardware, rtsp_url: str|None, error: str|None }`. `probe(timeout_s) -> list[str]` (device-service XAddr URLs); `onvif_factory(host, port, user, password) -> onvif client`. Both injectable for host testing.

> **Test-env note:** the test imports ONLY `app.discovery` and passes fake `probe`/`onvif_factory` — no `WSDiscovery`/`onvif` needed on the host. Use `python3 -m pytest`.

- [ ] **Step 1: Write the failing tests**

`worker/tests/test_discovery.py`:
```python
import unittest
from app.discovery import discover_onvif


class _Info:
    Manufacturer = "Acme"
    Model = "Cam9"


class _Media:
    def GetProfiles(self):
        return [type("P", (), {"token": "t0"})()]

    def GetStreamUri(self, req):
        return type("U", (), {"Uri": "rtsp://192.168.1.64:554/s0"})()


class _DevMgmt:
    def GetDeviceInformation(self):
        return _Info()


class _Cam:
    def __init__(self):
        self.devicemgmt = _DevMgmt()

    def create_media_service(self):
        return _Media()


def probe_one(_timeout):
    return ["http://192.168.1.64/onvif/device_service"]


def factory_ok(host, port, user, password):
    return _Cam()


class TestDiscovery(unittest.TestCase):
    def test_maps_device_to_name_ip_rtsp(self):
        r = discover_onvif("u", "p", probe=probe_one, onvif_factory=factory_ok)
        self.assertEqual(len(r), 1)
        self.assertEqual(r[0]["ip"], "192.168.1.64")
        self.assertEqual(r[0]["name"], "Acme Cam9")
        self.assertEqual(r[0]["rtsp_url"], "rtsp://192.168.1.64:554/s0")
        self.assertIsNone(r[0]["error"])

    def test_getstreamuri_failure_sets_error_no_crash(self):
        def factory_bad(host, port, user, password):
            raise RuntimeError("401 unauthorized")
        r = discover_onvif("u", "p", probe=probe_one, onvif_factory=factory_bad)
        self.assertEqual(len(r), 1)
        self.assertIsNone(r[0]["rtsp_url"])
        self.assertIn("401", r[0]["error"])
        self.assertEqual(r[0]["ip"], "192.168.1.64")  # still listed with its IP

    def test_empty_probe_returns_empty(self):
        self.assertEqual(discover_onvif("u", "p", probe=lambda t: [], onvif_factory=factory_ok), [])

    def test_dedupes_by_host(self):
        def probe_dup(_t):
            return ["http://192.168.1.64/onvif/device_service",
                    "http://192.168.1.64:8000/onvif/device_service"]
        r = discover_onvif("u", "p", probe=probe_dup, onvif_factory=factory_ok)
        self.assertEqual(len(r), 1)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && python3 -m pytest tests/test_discovery.py -q`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `worker/app/discovery.py`**

```python
import urllib.parse


def _default_probe(timeout_s):
    # Heavy import kept local so the pure tests don't need the lib.
    from wsdiscovery.discovery import ThreadedWSDiscovery
    from wsdiscovery import QName
    wsd = ThreadedWSDiscovery()
    wsd.start()
    try:
        nvt = QName("http://www.onvif.org/ver10/network/wsdl", "NetworkVideoTransmitter")
        services = wsd.searchServices(types=[nvt], timeout=timeout_s)
        xaddrs = []
        for s in services:
            xaddrs.extend(s.getXAddrs())
        return xaddrs
    finally:
        wsd.stop()


def _default_onvif_factory(host, port, user, password):
    from onvif import ONVIFCamera
    return ONVIFCamera(host, port, user, password)


def discover_onvif(username, password, timeout_s=5, *,
                   probe=_default_probe, onvif_factory=_default_onvif_factory):
    """Find ONVIF cameras and resolve each RTSP URL. Network primitives are
    injected so the mapping is host-testable without the ONVIF libs."""
    results = []
    seen = set()
    for xaddr in probe(timeout_s):
        parsed = urllib.parse.urlparse(xaddr)
        host = parsed.hostname
        port = parsed.port or 80
        if not host or host in seen:
            continue
        seen.add(host)
        entry = {"name": host, "ip": host, "hardware": None, "rtsp_url": None, "error": None}
        try:
            cam = onvif_factory(host, port, username, password)
            info = cam.devicemgmt.GetDeviceInformation()
            name = f"{getattr(info, 'Manufacturer', '') or ''} {getattr(info, 'Model', '') or ''}".strip()
            entry["name"] = name or host
            entry["hardware"] = getattr(info, "Model", None)
            media = cam.create_media_service()
            profiles = media.GetProfiles()
            token = profiles[0].token
            uri = media.GetStreamUri({
                "StreamSetup": {"Stream": "RTP-Unicast", "Transport": {"Protocol": "RTSP"}},
                "ProfileToken": token,
            })
            entry["rtsp_url"] = uri.Uri
        except Exception as e:  # noqa: BLE001 - any device error → listed with an error
            entry["error"] = str(e)[:160]
        results.append(entry)
    return results
```

- [ ] **Step 4: Run**

Run: `cd worker && python3 -m pytest tests/test_discovery.py -q`
Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add worker/app/discovery.py worker/tests/test_discovery.py
git commit -m "feat(worker): ONVIF discovery core (WS-Discovery + GetStreamUri, injectable)"
```

---

### Task 2: Worker `discover` command handler + deps

**Files:**
- Modify: `worker/app/main.py` (`handle_command` + a `handle_discover`)
- Modify: `worker/app/config.py` (`DISCOVERY_TIMEOUT_S`)
- Modify: `worker/requirements.txt` (add `WSDiscovery`, `onvif-zeep`)

**Interfaces:**
- Consumes: `discover_onvif` (Task 1); the existing `self.publish(channel, payload)`.
- Produces: on a `discover` command, publishes `{scan_id, user_id, cameras}` to `discovery:results`.

> **Test-env note:** av/onvif-coupled runtime — no host unit test; verified by the Task 7 manual scan. The pure `discover_onvif` is Task 1.

- [ ] **Step 1: Config + deps**

`worker/app/config.py` add: `DISCOVERY_TIMEOUT_S = float(os.environ.get("DISCOVERY_TIMEOUT_S", "5"))`.
`worker/requirements.txt` add two lines: `WSDiscovery` and `onvif-zeep`.

- [ ] **Step 2: Handle `discover` BEFORE the camera_id guard**

In `worker/app/main.py` `handle_command`, add the discover branch at the very top (a discover command has NO `camera_id`, so it must precede the `if not cid: return` guard):
```python
    async def handle_command(self, cmd: dict) -> None:
        kind = cmd.get("type")
        if kind == "discover":
            await self.handle_discover(cmd)
            return
        cid = cmd.get("camera_id")
        if not cid:
            return
        # ... existing start / rules_update / stop unchanged ...
```
Add the handler (runs the blocking discovery off the event loop):
```python
    async def handle_discover(self, cmd: dict) -> None:
        from .discovery import discover_onvif
        from .config import DISCOVERY_TIMEOUT_S
        scan_id = cmd.get("scan_id")
        user_id = cmd.get("user_id")
        try:
            cams = await asyncio.to_thread(
                discover_onvif, cmd.get("username", ""), cmd.get("password", ""), DISCOVERY_TIMEOUT_S
            )
            await self.publish("discovery:results", {"scan_id": scan_id, "user_id": user_id, "cameras": cams})
        except Exception as e:
            log.exception("discovery failed")
            await self.publish("discovery:results",
                               {"scan_id": scan_id, "user_id": user_id, "cameras": [], "error": str(e)[:200]})
```

- [ ] **Step 3: Sanity — pure suite still green**

Run: `cd worker && python3 -m pytest -q`
Expected: all pass (the discovery pure tests + prior suites; `main.py` isn't imported by host tests).

- [ ] **Step 4: Commit**

```bash
git add worker/app/main.py worker/app/config.py worker/requirements.txt
git commit -m "feat(worker): handle discover command -> publish discovery:results"
```

---

### Task 3: Backend — `discover` command type + `POST /discovery/scan`

**Files:**
- Modify: `backend/src/realtime/channels.ts` (union + `discoveryResults` channel)
- Create: `backend/src/discovery/routes.ts`
- Modify: `backend/src/app.ts` (mount)
- Test: `backend/test/discovery.test.ts`

**Interfaces:**
- Produces: `POST /discovery/scan` (auth) body `{username, password}` → publishes a `discover` command (via `publishCommand`) with `scan_id` + the caller's `user_id`, returns `{ scan_id }`. `CHANNELS.discoveryResults = "discovery:results"`.

- [ ] **Step 1: Extend channels.ts**

Add to `CHANNELS`: `discoveryResults: "discovery:results", // worker -> API`.
Add to the `CameraCommand` union:
```ts
  | { type: "discover"; scan_id: string; user_id: string; username: string; password: string; ts: string };
```

- [ ] **Step 2: Discovery route**

`backend/src/discovery/routes.ts`:
```ts
import { Hono } from "hono";
import { requireAuth } from "../auth/middleware";
import { publishCommand } from "../realtime/channels";

export const discoveryRoutes = new Hono();
discoveryRoutes.use("*", requireAuth);

discoveryRoutes.post("/scan", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const username = typeof b?.username === "string" ? b.username : "";
  const password = typeof b?.password === "string" ? b.password : "";
  const scanId = crypto.randomUUID();
  await publishCommand({
    type: "discover", scan_id: scanId, user_id: c.get("userId"),
    username, password, ts: new Date().toISOString(),
  });
  return c.json({ scan_id: scanId });
});
```
Mount in `backend/src/app.ts`: `import { discoveryRoutes } from "./discovery/routes";` + `app.route("/discovery", discoveryRoutes);`.

- [ ] **Step 3: Test**

`backend/test/discovery.test.ts` (mirror the DB-gated auth pattern; the scan endpoint doesn't need the DB but `requireAuth` needs a real user, so keep the `dbUp` gate + `nuser()`):
```ts
import { test, expect, beforeAll } from "bun:test";
import { sql } from "drizzle-orm";
import { app } from "../src/app";
import { db } from "../src/db";

let dbUp = false;
beforeAll(async () => { try { await db.execute(sql`select 1`); dbUp = true; } catch { dbUp = false; } });
const call = (p: string, o: RequestInit = {}) => app.fetch(new Request(`http://test${p}`, o));
const json = (b: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
const rnd = () => Math.random().toString(36).slice(2, 9);
async function nuser() {
  const r = await call("/auth/signup", json({ username: "n_" + rnd(), password: "secret12" }));
  const { token } = await r.json();
  return (p: string, o: RequestInit = {}) => call(p, { ...o, headers: { ...(o.headers ?? {}), Authorization: `Bearer ${token}` } });
}

test("POST /discovery/scan requires auth", async () => {
  expect((await call("/discovery/scan", json({ username: "u", password: "p" }))).status).toBe(401);
});

test("POST /discovery/scan returns a scan_id for an authed caller", async () => {
  if (!dbUp) return;
  const a = await nuser();
  const res = await a("/discovery/scan", json({ username: "admin", password: "pw" }));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(typeof body.scan_id).toBe("string");
  expect(body.scan_id.length).toBeGreaterThan(10);
});
```
(This exercises auth + the response contract. The published-command shape is guarded by the `CameraCommand` union type; the real dispatch is covered by the manual scan.)

- [ ] **Step 4: Run**

Run: `cd backend && RECORDINGS_DIR=/tmp/vms-rec DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun test test/discovery.test.ts` and `bunx tsc --noEmit`.
Expected: pass; 0 tsc errors.

- [ ] **Step 5: Commit**

```bash
git add backend/src/realtime/channels.ts backend/src/discovery/routes.ts backend/src/app.ts backend/test/discovery.test.ts
git commit -m "feat(api): POST /discovery/scan dispatches an ONVIF discover command"
```

---

### Task 4: Backend — relay `discovery:results` to the user's WebSocket

**Files:**
- Modify: `backend/src/realtime/ingest.ts`
- Test: `backend/test/discovery.test.ts`

**Interfaces:**
- Produces: `onDiscoveryResults(msg, send = sendToUser)` — relays `{channel:"discovery", data: msg}` to `msg.user_id`; `startIngest` subscribes `CHANNELS.discoveryResults` and dispatches to it.

- [ ] **Step 1: Subscribe + dispatch + handler**

In `backend/src/realtime/ingest.ts`:
- Add `CHANNELS.discoveryResults` to the `redisSub.subscribe(...)` list.
- Add a dispatch branch in the `on("message")` switch: `else if (channel === CHANNELS.discoveryResults) onDiscoveryResults(msg);`
- Add the exported handler (injectable `send` for testing):
```ts
export function onDiscoveryResults(msg: any, send = sendToUser): void {
  if (msg?.user_id) send(msg.user_id, { channel: "discovery", data: msg });
}
```

- [ ] **Step 2: Test the relay**

Add to `backend/test/discovery.test.ts`:
```ts
import { onDiscoveryResults } from "../src/realtime/ingest";

test("onDiscoveryResults relays to the requesting user's socket", () => {
  const sent: any[] = [];
  const fakeSend = (uid: string, payload: any) => { sent.push({ uid, payload }); };
  onDiscoveryResults({ user_id: "u1", scan_id: "s1", cameras: [{ ip: "1.2.3.4" }] }, fakeSend);
  expect(sent.length).toBe(1);
  expect(sent[0].uid).toBe("u1");
  expect(sent[0].payload.channel).toBe("discovery");
  expect(sent[0].payload.data.cameras[0].ip).toBe("1.2.3.4");
});
test("onDiscoveryResults ignores a message with no user_id", () => {
  const sent: any[] = [];
  onDiscoveryResults({ scan_id: "s1", cameras: [] }, (u, p) => sent.push({ u, p }));
  expect(sent.length).toBe(0);
});
```

- [ ] **Step 3: Run**

Run: `cd backend && RECORDINGS_DIR=/tmp/vms-rec DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun test test/discovery.test.ts` + `bunx tsc --noEmit`.
Expected: pass; 0 tsc.

- [ ] **Step 4: Commit**

```bash
git add backend/src/realtime/ingest.ts backend/test/discovery.test.ts
git commit -m "feat(api): relay discovery:results to the requesting user's WebSocket"
```

---

### Task 5: Frontend — types + api + realtime discovery channel

**Files:**
- Modify: `frontend/lib/types.ts`
- Modify: `frontend/lib/api.ts`
- Modify: `frontend/lib/realtime.ts`

**Interfaces:**
- Produces: `DiscoveredCamera`; `api.scanNetwork(username, password)`; the realtime hook exposes `discovered: DiscoveredCamera[]` accumulated from the `discovery` WS channel.

- [ ] **Step 1: Type**

`frontend/lib/types.ts`:
```ts
export type DiscoveredCamera = {
  name: string;
  ip: string;
  hardware?: string | null;
  rtsp_url: string | null;
  error: string | null;
};
```

- [ ] **Step 2: api**

`frontend/lib/api.ts` add:
```ts
  scanNetwork: (username: string, password: string) =>
    req("/discovery/scan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) }),
```

- [ ] **Step 3: realtime hook**

In `frontend/lib/realtime.ts`, add a `discovered` state and merge on the `discovery` channel. Find the `msg.channel === "stats"` handling and add alongside:
```ts
        } else if (msg.channel === "discovery") {
          const cams = (msg.data?.cameras ?? []) as DiscoveredCamera[];
          setDiscovered((prev) => {
            const byIp = new Map(prev.map((c) => [c.ip, c]));
            for (const c of cams) byIp.set(c.ip, c);
            return Array.from(byIp.values());
          });
        }
```
Add `const [discovered, setDiscovered] = useState<DiscoveredCamera[]>([]);` and return `discovered` (+ a `clearDiscovered = () => setDiscovered([])`) from the hook. Import `DiscoveredCamera`.

- [ ] **Step 4: Build**

Run: `cd frontend && npm run build`
Expected: compiles.

- [ ] **Step 5: Commit**

```bash
git add frontend/lib/types.ts frontend/lib/api.ts frontend/lib/realtime.ts
git commit -m "feat(web): discovery types + scanNetwork api + realtime discovery channel"
```

---

### Task 6: Frontend — Scan network UI + Add prefill

**Files:**
- Create: `frontend/components/ScanModal.tsx`
- Modify: `frontend/components/CameraForm.tsx` (a `prefill` prop)
- Modify: `frontend/app/dashboard/page.tsx` (Scan button + wire the modal + prefill)

**Interfaces:**
- Consumes: `api.scanNetwork`, the hook's `discovered` + `clearDiscovered`, `DiscoveredCamera`, the existing `cameras` list (for the already-added marker).

- [ ] **Step 1: CameraForm prefill prop**

In `frontend/components/CameraForm.tsx`, add an optional `prefill?: { name?: string; rtspUrl?: string }` to `Props`, and use it as the add-mode initial state:
```ts
  const [name, setName] = useState(camera?.name ?? prefill?.name ?? "");
  const [rtsp, setRtsp] = useState(camera?.rtspUrl ?? prefill?.rtspUrl ?? "");
```

- [ ] **Step 2: ScanModal**

`frontend/components/ScanModal.tsx`: a modal with username + password + Scan; on Scan, `api.scanNetwork(username, password)` then show a spinner + the `discovered` list (passed in as a prop from the dashboard hook). Each row: name, ip, hardware; if `rtsp_url` → an **Add** button (calls `onAdd({ name, rtspUrl: rtsp_url })`); if `error` → a muted note. Mark rows whose `rtsp_url` or `ip` matches an existing camera as "already added" (Add disabled).
```tsx
"use client";
import { useState } from "react";
import { api } from "@/lib/api";
import type { Camera, DiscoveredCamera } from "@/lib/types";

type Props = {
  discovered: DiscoveredCamera[];
  cameras: Camera[];
  onClose: () => void;
  onAdd: (p: { name: string; rtspUrl: string }) => void;
};

export function ScanModal({ discovered, cameras, onClose, onAdd }: Props) {
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const existing = new Set(cameras.map((c) => c.rtspUrl));

  async function scan() {
    setErr(null); setBusy(true);
    try { await api.scanNetwork(user, pass); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card modal" onClick={(e) => e.stopPropagation()}>
        <h2>Scan network for cameras</h2>
        <label>Username <input value={user} onChange={(e) => setUser(e.target.value)} /></label>
        <label>Password <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} /></label>
        {err && <p className="error">{err}</p>}
        <button className="primary" onClick={scan} disabled={busy}>{busy ? "Scanning…" : "Scan"}</button>
        <div className="rules-list">
          {discovered.length === 0 && <p className="muted small">No cameras found yet. Scan looks for ONVIF cameras on your network.</p>}
          {discovered.map((d) => {
            const added = d.rtsp_url ? existing.has(d.rtsp_url) : false;
            return (
              <div key={d.ip} className="rule-row">
                <strong>{d.name}</strong>
                <span className="muted small">{d.ip}{d.hardware ? ` · ${d.hardware}` : ""}</span>
                {d.rtsp_url ? (
                  added ? <span className="muted small">already added</span>
                    : <button onClick={() => onAdd({ name: d.name, rtspUrl: d.rtsp_url! })}>Add</button>
                ) : <span className="muted small">{d.error ?? "needs credentials / not ONVIF"}</span>}
              </div>
            );
          })}
        </div>
        <button onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Wire the dashboard**

In `frontend/app/dashboard/page.tsx`: add `const [showScan, setShowScan] = useState(false)` and a `prefill` state `useState<{name?:string;rtspUrl?:string}|null>(null)`. Get `discovered` + `clearDiscovered` from the realtime hook. Add a **"Scan network"** button next to "+ Add camera". Render `<ScanModal>` when `showScan`, passing `discovered`, `cameras`, `onClose={() => { setShowScan(false); clearDiscovered(); }}`, and `onAdd={(p) => { setShowScan(false); setPrefill(p); setShowForm(true); }}`. Pass `prefill` to `<CameraForm prefill={prefill ?? undefined} ...>` and clear it on close/save.

- [ ] **Step 4: Build**

Run: `cd frontend && npm run build`
Expected: compiles; `/dashboard` renders the Scan button + modal.

- [ ] **Step 5: Commit**

```bash
git add frontend/components/ScanModal.tsx frontend/components/CameraForm.tsx frontend/app/dashboard/page.tsx
git commit -m "feat(web): Scan network modal + Add prefills the camera form"
```

---

### Task 7: Docs + suites + verification

**Files:**
- Modify: `.env.example`, `README.md`, `docs/EVENT_FORMAT.md`
- Verify: suites + a mock/manual scan

- [ ] **Step 1: Docs**

`.env.example` (worker section): `DISCOVERY_TIMEOUT_S=5` with a comment. README: note "Scan network" finds ONVIF cameras on the LAN and prefills the RTSP URL (one credential set per scan; non-ONVIF cameras use the manual add form). `docs/EVENT_FORMAT.md`: document the `discover` command (§ API→worker) and the `discovery:results` message (§ worker→API) shapes.

- [ ] **Step 2: Full suites**

Run: `cd backend && RECORDINGS_DIR=/tmp/vms-rec DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun test` → all pass; `bunx tsc --noEmit` → 0.
Run: `cd worker && python3 -m pytest -q` → all pass.
Run: `cd frontend && npm run build` → clean.

- [ ] **Step 3: SKIP — controller verifies**

The controller: rebuilds `backend worker`, confirms the stack is healthy, and drives the mock-level e2e — `POST /discovery/scan` returns a `scan_id`, and a synthetic `discovery:results` message published to Redis is relayed to the user's WebSocket (verifiable by publishing to the channel and observing the WS, or via the unit-tested relay). A REAL ONVIF-camera scan is documented as manual verification (no ONVIF device in the docker stack) — the controller notes this rather than blocking on it.

- [ ] **Step 4: Commit**

```bash
git add .env.example README.md docs/EVENT_FORMAT.md
git commit -m "docs: ONVIF discovery (M4b); scan command + results format"
```

---

## Notes for the executor

- `discover_onvif` is the only host-testable worker logic (injected network primitives); the `main.py` handler + the real multicast are manual/e2e — do NOT import `main`/`camera_worker` in a host test.
- The `discover` command has NO `camera_id` — it MUST be handled before `handle_command`'s `if not cid: return` guard, or it's silently dropped.
- Keep the scan crash-safe: a discovery exception publishes an empty result with an `error`, never kills the worker command loop; the backend relay never throws into ingest.
- Results are transient — no table, no persistence. The WS relay reuses the exact worker→Redis→`sendToUser` path the other events use.
