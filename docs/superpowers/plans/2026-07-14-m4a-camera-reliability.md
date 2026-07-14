# M4a Camera Reconnect + Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cameras self-heal — a dropped RTSP stream reconnects with backoff, escalates to `offline` after a grace window, fires an opt-in offline/recovery notification, and surfaces health (last-seen / fps / reconnects) in the UI.

**Architecture:** The worker owns a per-camera connection state machine (`connecting → live ⇄ reconnecting → offline`) driven by a pure, host-testable `ReconnectState`. The backend's `onStats` reacts to `camera_state` events — updates status + `lastSeenAt`, and on the offline/recovery transitions (if the camera opted in) dispatches a synthetic camera event through the existing M3 `dispatchNotifications` pipeline (not persisted as an alert). The frontend shows health + a per-camera "notify if offline" toggle.

**Tech Stack:** Python/PyAV (worker); Bun + Hono + Drizzle + Postgres (backend); Next.js/React (frontend). Reuses the M3 notify pipeline.

## Global Constraints

- **Worker owns the state machine; backend reacts.** The worker emits `camera_state` events (`connecting|live|reconnecting|offline`); the backend never computes reconnect logic.
- **Reconnect = exponential backoff** floor 1s, ×2, **cap 30s**, reset to floor on a successful connect; retry forever until `stop()`.
- **Grace before offline** (~60s, `OFFLINE_GRACE_S`): a drop is `reconnecting` (silent); only sustained-down > grace → `offline`. **Stall watchdog** ~10s (`STALL_TIMEOUT_S`): `live` but no frame → reconnect.
- **Offline notification is opt-in per camera** (`cameras.notifyOnOffline`, default false), fires on →`offline` and on recovery (→`live` from `offline`); reuses channel `cameraIds` + `minSeverity` filters + cooldown; the camera event is **NOT** inserted into the alerts table and does **NOT** enqueue the retry queue.
- **Non-blocking:** a camera-event dispatch failure must never break stats ingest or the WS fanout (same try/catch envelope as M3 `dispatchNotifications`).
- **Additive:** new columns nullable/defaulted; `CameraStatus` union extended (keep `error` for legacy rows).
- **Commits:** author Samar only, NO `Co-Authored-By: Claude` trailer. `git add` explicit paths only (an untracked `docs/CODE_WALKTHROUGH.md` exists — never commit it).
- **Test envs:** host `python3` has NO `aiortc`/`av` — worker tests import ONLY pure modules (`reconnect.py`), never `camera_worker`; run `python3 -m pytest`. Backend DB tests: `RECORDINGS_DIR=/tmp/vms-rec DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun test` (the RECORDINGS_DIR override is required project-wide). tsc is a gate: `cd backend && bunx tsc --noEmit` → 0.

---

### Task 1: DB — `cameras.lastSeenAt` + `notifyOnOffline`

**Files:**
- Modify: `backend/src/db/schema.ts`
- Test: `backend/test/cameras.test.ts` (add a smoke assertion, or create if absent — mirror `test/notify.test.ts`'s DB-gated pattern)

**Interfaces:**
- Produces: `cameras.lastSeenAt` (timestamptz null), `cameras.notifyOnOffline` (boolean not null default false).

- [ ] **Step 1: Add the columns**

In the `cameras` table object in `schema.ts`, after `status`:
```ts
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    notifyOnOffline: boolean("notify_on_offline").notNull().default(false),
```

- [ ] **Step 2: Apply the migration**

Run: `cd backend && DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bunx drizzle-kit push`
Expected: adds the two columns (choose create, not rename, if prompted).

- [ ] **Step 3: Smoke test**

In a DB-gated test (reuse or create `backend/test/cameras.test.ts` with the `dbUp` pattern from `test/notify.test.ts`):
```ts
test("cameras carry lastSeenAt + notifyOnOffline", async () => {
  if (!dbUp) return;
  const rows = await db.select({ a: cameras.lastSeenAt, b: cameras.notifyOnOffline }).from(cameras).limit(1);
  expect(Array.isArray(rows)).toBe(true);
});
```

- [ ] **Step 4: Run**

Run: `cd backend && DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun test test/cameras.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/db/schema.ts backend/test/cameras.test.ts
git commit -m "feat(db): cameras.lastSeenAt + notifyOnOffline"
```

---

### Task 2: Worker pure reconnect logic (TDD, host-testable)

**Files:**
- Create: `worker/app/reconnect.py`
- Test: `worker/tests/test_reconnect.py`

**Interfaces:**
- Produces: `backoff_next(current_s, start_s, max_s) -> float`; `ReconnectState(grace_s, stall_s, backoff_start_s, backoff_max_s)` with `state` (`"connecting"|"live"|"reconnecting"|"offline"`), `current_backoff`, `reconnect_count`, `last_frame_at`, and methods `on_connect_ok(now)`, `on_frame(now)`, `on_drop(now)`, `tick(now)`, `is_stalled(now)` — each transition method returns `True` iff `state` changed.

> **Test-env note:** imports ONLY `app.reconnect` (pure, no PyAV). The av-coupled wiring is Task 3, verified by the Task 8 docker e2e. Use `python3 -m pytest`.

- [ ] **Step 1: Write the failing tests**

`worker/tests/test_reconnect.py`:
```python
import unittest
from app.reconnect import backoff_next, ReconnectState


class TestBackoff(unittest.TestCase):
    def test_grows_and_caps_and_resets(self):
        self.assertEqual(backoff_next(0, 1, 30), 1)     # from zero -> floor
        self.assertEqual(backoff_next(1, 1, 30), 2)
        self.assertEqual(backoff_next(2, 1, 30), 4)
        self.assertEqual(backoff_next(16, 1, 30), 30)   # 32 capped to 30
        self.assertEqual(backoff_next(30, 1, 30), 30)   # stays capped


def rs():
    return ReconnectState(grace_s=60, stall_s=10, backoff_start_s=1, backoff_max_s=30)


class TestReconnectState(unittest.TestCase):
    def test_connect_ok_goes_live_and_resets_backoff(self):
        s = rs()
        self.assertTrue(s.on_connect_ok(0.0))
        self.assertEqual(s.state, "live")
        self.assertEqual(s.current_backoff, 0)

    def test_drop_enters_reconnecting_counts_once_grows_backoff(self):
        s = rs(); s.on_connect_ok(0.0)
        self.assertTrue(s.on_drop(1.0))            # live -> reconnecting (changed)
        self.assertEqual(s.state, "reconnecting")
        self.assertEqual(s.reconnect_count, 1)
        self.assertEqual(s.current_backoff, 1)
        self.assertFalse(s.on_drop(2.0))           # still reconnecting (no state change)
        self.assertEqual(s.current_backoff, 2)     # backoff still grows per retry
        self.assertEqual(s.reconnect_count, 1)     # not re-counted within one episode

    def test_tick_escalates_to_offline_after_grace(self):
        s = rs(); s.on_connect_ok(0.0); s.on_drop(1.0)
        self.assertFalse(s.tick(30.0))             # within grace
        self.assertEqual(s.state, "reconnecting")
        self.assertTrue(s.tick(62.0))              # > 60s since reconnecting_since(=1.0)
        self.assertEqual(s.state, "offline")

    def test_reconnect_from_offline_goes_live_and_resets(self):
        s = rs(); s.on_connect_ok(0.0); s.on_drop(1.0); s.tick(62.0)
        self.assertEqual(s.state, "offline")
        self.assertTrue(s.on_connect_ok(70.0))
        self.assertEqual(s.state, "live")
        self.assertEqual(s.current_backoff, 0)
        # a fresh drop after recovery counts a new episode
        s.on_drop(71.0)
        self.assertEqual(s.reconnect_count, 2)

    def test_is_stalled_when_live_and_no_recent_frame(self):
        s = rs(); s.on_connect_ok(0.0); s.on_frame(0.0)
        self.assertFalse(s.is_stalled(5.0))
        self.assertTrue(s.is_stalled(11.0))        # > stall_s(10)
        s.on_drop(11.0)
        self.assertFalse(s.is_stalled(30.0))       # not live -> never "stalled"


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && python3 -m pytest tests/test_reconnect.py -q`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `worker/app/reconnect.py`**

```python
def backoff_next(current_s: float, start_s: float, max_s: float) -> float:
    """Exponential backoff: floor on the first retry, then double, capped."""
    if current_s <= 0:
        return start_s
    return min(current_s * 2, max_s)


class ReconnectState:
    """Pure per-camera connection state machine. The worker calls the event
    methods around real PyAV open/decode; the transitions here are host-tested.
    Each event method returns True iff `state` changed (so the caller emits a
    camera_state event only on change)."""

    def __init__(self, grace_s: float, stall_s: float, backoff_start_s: float, backoff_max_s: float):
        self.grace_s = grace_s
        self.stall_s = stall_s
        self._backoff_start = backoff_start_s
        self._backoff_max = backoff_max_s
        self.state = "connecting"
        self.current_backoff = 0.0
        self.reconnect_count = 0
        self.last_frame_at = None
        self._reconnecting_since = None

    def on_connect_ok(self, now: float) -> bool:
        changed = self.state != "live"
        self.state = "live"
        self.current_backoff = 0.0
        self._reconnecting_since = None
        self.last_frame_at = now
        return changed

    def on_frame(self, now: float) -> None:
        self.last_frame_at = now

    def on_drop(self, now: float) -> bool:
        # A fresh episode: coming from live/connecting (not already down).
        fresh = self.state not in ("reconnecting", "offline")
        if fresh:
            self.reconnect_count += 1
            self._reconnecting_since = now
        elif self._reconnecting_since is None:
            self._reconnecting_since = now
        changed = self.state == "live" or self.state == "connecting"
        if self.state != "offline":
            self.state = "reconnecting"
        self.current_backoff = backoff_next(self.current_backoff, self._backoff_start, self._backoff_max)
        return changed

    def tick(self, now: float) -> bool:
        """Escalate a sustained reconnecting state to offline after the grace."""
        if self.state == "reconnecting" and self._reconnecting_since is not None \
                and now - self._reconnecting_since > self.grace_s:
            self.state = "offline"
            return True
        return False

    def is_stalled(self, now: float) -> bool:
        return self.state == "live" and self.last_frame_at is not None \
            and now - self.last_frame_at > self.stall_s
```

- [ ] **Step 4: Run**

Run: `cd worker && python3 -m pytest tests/test_reconnect.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add worker/app/reconnect.py worker/tests/test_reconnect.py
git commit -m "feat(worker): pure reconnect state machine + backoff (TDD)"
```

---

### Task 3: Worker wiring — reconnect loop + stall + health stats

**Files:**
- Modify: `worker/app/camera_worker.py` (`_decode_loop` → reconnect loop; `_stats_loop`)
- Modify: `worker/app/events.py` (`stats_event` gains `reconnect_count`, `last_frame_at`)
- Modify: `worker/app/config.py` (grace/stall/backoff env)

**Interfaces:**
- Consumes: `ReconnectState`, `backoff_next` (Task 2).
- Produces: the worker emits `reconnecting`/`offline`/`live` `camera_state` events + `reconnect_count`/`last_frame_at` in stats; survives RTSP drops.

> **Test-env note:** this task is av-coupled and NOT host-importable — no unit test here; the behavior is verified by the Task 8 docker e2e. Keep the pure logic in `reconnect.py` (Task 2, already tested).

- [ ] **Step 1: Config**

In `worker/app/config.py` add (near the other `os.environ` reads):
```python
OFFLINE_GRACE_S = float(os.environ.get("OFFLINE_GRACE_S", "60"))
STALL_TIMEOUT_S = float(os.environ.get("STALL_TIMEOUT_S", "10"))
RECONNECT_BACKOFF_START_S = float(os.environ.get("RECONNECT_BACKOFF_START_S", "1"))
RECONNECT_BACKOFF_MAX_S = float(os.environ.get("RECONNECT_BACKOFF_MAX_S", "30"))
```

- [ ] **Step 2: `stats_event` gains health fields**

In `worker/app/events.py` `stats_event`, add params `reconnect_count: int = 0, last_frame_at: str | None = None` and include `"reconnect_count": int(reconnect_count)`, `"last_frame_at": last_frame_at` in the returned dict.

- [ ] **Step 3: Rewrite `_decode_loop` as a reconnect loop**

Replace `_decode_loop` (worker/app/camera_worker.py) with a version that loops open+decode, driving a `ReconnectState`. Import at top: `from .reconnect import ReconnectState` and the four config constants. Use a monotonic clock (`time.monotonic()`), and expose `self._reconnect_count` + `self._last_frame_iso` for the stats loop.

```python
    def _decode_loop(self) -> None:
        import av, time
        from .events import now_iso
        rc = ReconnectState(OFFLINE_GRACE_S, STALL_TIMEOUT_S,
                            RECONNECT_BACKOFF_START_S, RECONNECT_BACKOFF_MAX_S)
        self._push_state("connecting")
        while not self._stop.is_set():
            container = None
            try:
                container = av.open(self.rtsp_url,
                    options={"rtsp_transport": "tcp", "stimeout": "5000000"})
                stream = container.streams.video[0]
            except Exception as e:
                log.warning("rtsp open failed: %s (%s)", self.camera_id, str(e)[:120])
                if rc.on_drop(time.monotonic()):
                    self._push_state(rc.state)
                self._backoff_wait(rc)
                continue
            if rc.on_connect_ok(time.monotonic()):
                self._push_state("live")
            self._reconnect_count = rc.reconnect_count
            self.recorder.set_stream(stream)
            try:
                self._demux(container, stream, rc)   # runs until stop, drop, or stall
            except Exception as e:
                log.warning("decode loop dropped: %s (%s)", self.camera_id, str(e)[:120])
            finally:
                try: self.recorder.close()
                except Exception: pass
                try: container.close()
                except Exception: pass
            if not self._stop.is_set():
                if rc.on_drop(time.monotonic()):
                    self._push_state(rc.state)
                self._backoff_wait(rc)

    def _backoff_wait(self, rc) -> None:
        # sleep the current backoff in small slices so stop() is responsive,
        # escalating reconnecting -> offline once the grace passes.
        import time
        deadline = time.monotonic() + rc.current_backoff
        while not self._stop.is_set() and time.monotonic() < deadline:
            if rc.tick(time.monotonic()):
                self._push_state(rc.state)     # -> offline
            self._reconnect_count = rc.reconnect_count
            time.sleep(0.2)
        if rc.tick(time.monotonic()):
            self._push_state(rc.state)
```

Extract the existing decode body into `_demux(self, container, stream, rc)`: the current `for packet in container.demux(stream): ...` loop, but (a) call `rc.on_frame(time.monotonic())` + set `self._last_frame_iso = now_iso()` after each decoded frame, and (b) after the fps update, if `rc.is_stalled(time.monotonic())`: `raise RuntimeError("stall")` to break out to the reconnect loop. Keep all existing detection/record/annotate logic unchanged. Remove the old `_push_state("error", ...)` calls — drops now flow through `rc`.

- [ ] **Step 4: Stats loop passes health**

In `_stats_loop`, pass the health fields:
```python
                    stats_event(
                        self.camera_id, self._fps, len(self._det_times), self.state,
                        reconnect_count=getattr(self, "_reconnect_count", 0),
                        last_frame_at=getattr(self, "_last_frame_iso", None),
                    )
```
Initialize `self._reconnect_count = 0` and `self._last_frame_iso = None` in `__init__`.

- [ ] **Step 5: Sanity — worker still imports (in docker) + pure tests pass**

Run: `cd worker && python3 -m pytest tests/test_reconnect.py -q` (pure tests unaffected — still pass).
Full worker-runtime verification is the Task 8 docker e2e (host can't import `camera_worker`).

- [ ] **Step 6: Commit**

```bash
git add worker/app/camera_worker.py worker/app/events.py worker/app/config.py
git commit -m "feat(worker): auto-reconnect with backoff + stall watchdog + health stats"
```

---

### Task 4: Backend — `dispatchCameraEvent`

**Files:**
- Modify: `backend/src/notify/dispatch.ts`
- Test: `backend/test/notify.test.ts`

**Interfaces:**
- Consumes: `shouldNotify`, `allow` (cooldown), `renderAlert`, `sendChannel`, `notificationChannels`.
- Produces: `dispatchCameraEvent(camera, ownerId, kind): Promise<void>` where `camera` has `{ id, name }` and `kind: "offline" | "online"`. Builds a synthetic event, runs the enabled channels through `shouldNotify` + `allow` + `renderAlert` + `sendChannel`; per-channel try/catch; never throws. No alert-row insert, no retry enqueue, no snapshot.

- [ ] **Step 1: Write the failing test**

```ts
test("dispatchCameraEvent notifies matching channels for an offline event", async () => {
  if (!dbUp) return;
  const { dispatchCameraEvent } = await import("../src/notify/dispatch");
  const a = await nuser();
  let received: any = null;
  const server = Bun.serve({ port: 0, async fetch(req) { received = await req.json(); return new Response("ok"); } });
  const cam = await (await a(`/cameras`, json({ name: "Gate", rtspUrl: "rtsp://x" }))).json();
  await a(`/notifications`, json({ type: "webhook", name: "hook", config: { url: `http://127.0.0.1:${server.port}/h` }, minSeverity: "low", cooldownSecs: 0 }));
  await dispatchCameraEvent({ id: cam.id, name: "Gate" }, cam.userId, "offline");
  await new Promise((r) => setTimeout(r, 50));
  expect(received?.event).toBe("alert");
  expect(String(received?.alert?.label)).toContain("offline");
  expect(received?.alert?.cameraId).toBe(cam.id);
  server.stop();
});
```
(`cam.userId` is returned by the create-camera response; if not, fetch it — the owner is the `nuser()` caller.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && RECORDINGS_DIR=/tmp/vms-rec DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun test test/notify.test.ts`
Expected: FAIL (`dispatchCameraEvent` not exported).

- [ ] **Step 3: Implement in `dispatch.ts`**

Add (reusing the existing imports + the same envelope as `dispatchNotifications`):
```ts
// A camera lifecycle event (offline / back online) — reuses the notify
// pipeline but is transient: no alert row, no snapshot, no retry enqueue.
export async function dispatchCameraEvent(
  camera: { id: string; name: string },
  ownerId: string,
  kind: "offline" | "online",
): Promise<void> {
  try {
    const channels = await db.select().from(notificationChannels)
      .where(and(eq(notificationChannels.userId, ownerId), eq(notificationChannels.enabled, true)));
    if (channels.length === 0) return;
    const label = kind === "offline" ? "camera offline" : "camera back online";
    const event: any = {
      id: crypto.randomUUID(), camera_id: camera.id, severity: "high",
      label, rule_id: null, ts: new Date().toISOString(), count: 0, confidence: 0,
    };
    const link = `${env.APP_URL}/dashboard`;
    const now = Date.now();
    for (const ch of channels) {
      try {
        if (!shouldNotify(ch, event)) continue;
        if (!allow(`${ch.id}:${camera.id}:camera`, now, ch.cooldownSecs)) continue;
        const payload = renderAlert(ch.type, event, camera.name, label, link, null);
        await sendChannel(ch.type, ch.config, payload, null);
      } catch (e) {
        console.error(`[notify] camera-event channel ${ch.id} (${ch.type}) failed:`, (e as Error).message);
      }
    }
  } catch (e) {
    console.error("[notify] camera-event dispatch failed:", (e as Error).message);
  }
}
```
(`crypto.randomUUID()` is global in Bun. Cooldown key is suffixed `:camera` so a camera-offline event and a detection on the same camera/channel don't share a window.)

- [ ] **Step 4: Run**

Run: `cd backend && RECORDINGS_DIR=/tmp/vms-rec DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun test test/notify.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/notify/dispatch.ts backend/test/notify.test.ts
git commit -m "feat(api): dispatchCameraEvent — offline/recovery notifications"
```

---

### Task 5: Backend — `onStats` transition detection + dispatch

**Files:**
- Modify: `backend/src/realtime/ingest.ts` (`onStats`)
- Test: `backend/test/cameras.test.ts` (or a new `backend/test/camera-state.test.ts`)

**Interfaces:**
- Consumes: `dispatchCameraEvent` (Task 4), `cameras`.
- Produces: `onStats` updates `cameras.status` + `lastSeenAt`, and on the transition into `offline` (prior ≠ offline) or into `live` (prior = offline), if `notifyOnOffline`, dispatches the camera event.

- [ ] **Step 1: Rewrite the `camera_state` branch of `onStats`**

In `backend/src/realtime/ingest.ts`, replace the `onStats` `camera_state` handling. Import `dispatchCameraEvent` from `../notify/dispatch`. Current code updates only `status`; change to read the prior row first, then update + detect transition:
```ts
async function onStats(s: any) {
  if (!s?.camera_id) return;
  if (s.type === "camera_state" && s.state) {
    const [cam] = await db.select().from(cameras).where(eq(cameras.id, s.camera_id)).limit(1);
    const prev = cam?.status;
    await db.update(cameras)
      .set({ status: s.state, lastSeenAt: new Date(), updatedAt: new Date() })
      .where(eq(cameras.id, s.camera_id)).catch(() => {});
    if (cam && cam.notifyOnOffline) {
      const enteringOffline = s.state === "offline" && prev !== "offline";
      const recovered = s.state === "live" && prev === "offline";
      if (enteringOffline || recovered) {
        void dispatchCameraEvent({ id: cam.id, name: cam.name }, cam.userId, enteringOffline ? "offline" : "online");
      }
    }
  } else if (s.type === "camera_stats") {
    // heartbeat: freeze lastSeenAt at the last time we heard from the camera
    await db.update(cameras).set({ lastSeenAt: new Date() }).where(eq(cameras.id, s.camera_id)).catch(() => {});
  }
  const owner = await ownerOf(s.camera_id);
  if (owner) {
    const channel = s.type === "camera_state" ? "state" : "stats";
    sendToUser(owner, { channel, data: s });
  }
}
```
(Keep the existing WS fanout at the bottom. The `camera_stats` `lastSeenAt` write is one small update per second per running camera — fine at self-hosted scale; throttling is a deferred optimization.)

- [ ] **Step 2: Write the test**

In `backend/test/cameras.test.ts` (DB-gated), drive `onStats` indirectly is hard (it's redis-fed) — instead export a thin testable helper OR test the transition logic by calling the DB + `dispatchCameraEvent` path. Simplest: extract the `camera_state` handling into an exported `applyCameraState(s)` in `ingest.ts` and unit-test it:
```ts
import { cameras } from "../src/db/schema";
import { eq } from "drizzle-orm";

test("applyCameraState: offline transition on an opted-in camera dispatches; opted-out does not", async () => {
  if (!dbUp) return;
  const a = await nuser();
  let hits = 0;
  const server = Bun.serve({ port: 0, fetch() { hits++; return new Response("ok"); } });
  const cam = await (await a(`/cameras`, json({ name: "C", rtspUrl: "rtsp://x" }))).json();
  await a(`/notifications`, json({ type: "webhook", name: "h", config: { url: `http://127.0.0.1:${server.port}/h` }, minSeverity: "low", cooldownSecs: 0 }));
  const { applyCameraState } = await import("../src/realtime/ingest");
  // opted OUT (default) -> no dispatch even on an offline transition
  await applyCameraState({ type: "camera_state", camera_id: cam.id, state: "live" });
  await applyCameraState({ type: "camera_state", camera_id: cam.id, state: "offline" });
  await new Promise((r) => setTimeout(r, 40));
  expect(hits).toBe(0);
  // opt in via a direct DB update (no dependency on Task 6's PATCH), then a
  // recovery transition (prev offline -> live) dispatches
  await db.update(cameras).set({ notifyOnOffline: true }).where(eq(cameras.id, cam.id));
  await applyCameraState({ type: "camera_state", camera_id: cam.id, state: "live" });
  await new Promise((r) => setTimeout(r, 40));
  expect(hits).toBeGreaterThanOrEqual(1);
  server.stop();
});
```
(Refactor `onStats`'s `camera_state` block into `export async function applyCameraState(s)` and call it from `onStats`. This test is self-contained — it sets `notifyOnOffline` directly, so it does not depend on Task 6.)

- [ ] **Step 3: Run to verify it fails, then implement, then pass**

Run: `cd backend && RECORDINGS_DIR=/tmp/vms-rec DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun test test/cameras.test.ts`
Expected: FAIL first (no `applyCameraState` export), then PASS after Step 1's refactor + implementation.

- [ ] **Step 4: Commit**

```bash
git add backend/src/realtime/ingest.ts backend/test/cameras.test.ts
git commit -m "feat(api): onStats offline/recovery transition dispatch + lastSeenAt"
```

---

### Task 6: Backend — camera `notifyOnOffline` CRUD

**Files:**
- Modify: `backend/src/cameras/routes.ts` (PATCH accepts `notify_on_offline`)
- Test: `backend/test/cameras.test.ts`

**Interfaces:**
- Produces: `PATCH /cameras/:id` accepts `notify_on_offline` (boolean) → `cameras.notifyOnOffline`; `GET`/`POST` responses already include the column (Drizzle returns the full row).

- [ ] **Step 1: Write the failing test**

```ts
test("PATCH /cameras/:id toggles notifyOnOffline", async () => {
  if (!dbUp) return;
  const a = await nuser();
  const cam = await (await a(`/cameras`, json({ name: "C2", rtspUrl: "rtsp://x" }))).json();
  expect(cam.notifyOnOffline).toBe(false);
  const upd = await (await a(`/cameras/${cam.id}`, { ...json({ notify_on_offline: true }), method: "PATCH" })).json();
  expect(upd.notifyOnOffline).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && RECORDINGS_DIR=/tmp/vms-rec DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun test test/cameras.test.ts`
Expected: FAIL (PATCH ignores the field).

- [ ] **Step 3: Implement**

In `backend/src/cameras/routes.ts` PATCH handler, after the existing `enabled` line:
```ts
  if (typeof b.notify_on_offline === "boolean") patch.notifyOnOffline = b.notify_on_offline;
```

- [ ] **Step 4: Run**

Run: `cd backend && RECORDINGS_DIR=/tmp/vms-rec DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun test test/cameras.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/cameras/routes.ts backend/test/cameras.test.ts
git commit -m "feat(api): PATCH camera notifyOnOffline"
```

---

### Task 7: Frontend — health + status + toggle

**Files:**
- Modify: `frontend/lib/types.ts`
- Modify: `frontend/components/CameraTile.tsx`
- Modify: `frontend/app/globals.css` (or the existing badge CSS file — badge color classes)

**Interfaces:**
- Consumes: `camera.notifyOnOffline`, `camera.lastSeenAt`, `stats.reconnect_count`, the extended `CameraStatus`.

- [ ] **Step 1: Types**

`frontend/lib/types.ts`:
- `CameraStatus`: add `"reconnecting" | "offline"` (keep `error`).
- `Camera`: add `notifyOnOffline: boolean;` and `lastSeenAt: string | null;`.
- `CamStats`: add `reconnect_count?: number; last_frame_at?: string | null;`.

- [ ] **Step 2: CameraTile — labels, badge, health, toggle**

In `frontend/components/CameraTile.tsx`:
- Extend `STATE_LABEL`: `reconnecting: "Reconnecting…", offline: "Offline",`.
- `isRunning` should treat `reconnecting`/`offline` as running (so Stop shows):
  ```ts
  const isRunning = ["live", "connecting", "reconnecting", "offline"].includes(cameraState) || isReceivingVideo;
  ```
- In the stats row, add reconnect count + last-seen:
  ```tsx
        <span>reconnects {stats?.reconnect_count ?? "—"}</span>
        <span>seen {camera.lastSeenAt ? new Date(camera.lastSeenAt).toLocaleTimeString() : "—"}</span>
  ```
- Add a "Notify if offline" toggle near the actions:
  ```tsx
        <label className="small">
          <input type="checkbox" defaultChecked={camera.notifyOnOffline}
            onChange={(e) => api.updateCamera(camera.id, { notify_on_offline: e.target.checked }).catch(() => {})} />
          Notify if offline
        </label>
  ```

- [ ] **Step 3: Badge colors**

In the CSS file that styles `.badge.live` / `.badge.connecting` (grep for `.badge.live`), add:
```css
.badge.reconnecting { background: #b45309; color: #fff; } /* amber */
.badge.offline { background: #b91c1c; color: #fff; }      /* red */
```
(Match the existing badge color convention — find the file with `grep -rn "badge.live\|badge\." frontend`.)

- [ ] **Step 4: Build**

Run: `cd frontend && npm run build`
Expected: compiles; `/dashboard` renders.

- [ ] **Step 5: Commit**

```bash
git add frontend/lib/types.ts frontend/components/CameraTile.tsx frontend/app/globals.css
git commit -m "feat(web): camera health (reconnecting/offline badge, last-seen, reconnects) + notify toggle"
```

---

### Task 8: Docs + suites + docker e2e

**Files:**
- Modify: `.env.example`, `README.md`
- Verify: all suites + live stack

- [ ] **Step 1: Docs**

`.env.example`: add (worker section) `OFFLINE_GRACE_S=60`, `STALL_TIMEOUT_S=10`, `RECONNECT_BACKOFF_START_S=1`, `RECONNECT_BACKOFF_MAX_S=30` with a comment. README: note cameras auto-reconnect with backoff, escalate to `offline` after `OFFLINE_GRACE_S`, and a per-camera "Notify if offline" toggle sends offline/recovery notifications via the M3 channels.

- [ ] **Step 2: Full suites**

Run: `cd backend && RECORDINGS_DIR=/tmp/vms-rec DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun test` → all pass; `bunx tsc --noEmit` → 0.
Run: `cd worker && python3 -m pytest -q` → all pass.
Run: `cd frontend && npm run build` → clean.

- [ ] **Step 3: SKIP — docker e2e run by the controller**

The controller rebuilds `worker backend`, starts a camera (→ live), then interrupts the stream (`docker compose stop streamer` or `mediamtx`) and verifies: status → `reconnecting` → `offline` after ~grace; an opt-in camera fires an offline notification to a capture webhook; restoring the stream (`docker compose start streamer`) → `reconnecting` → `live` + a recovery notification; `lastSeenAt` froze while down; other cameras + alert persistence unaffected. (`OFFLINE_GRACE_S` may be lowered for the e2e to shorten the wait.)

- [ ] **Step 4: Commit**

```bash
git add .env.example README.md
git commit -m "docs: camera reconnect + health (M4a); e2e verified"
```

---

## Notes for the executor

- The pure `ReconnectState` (Task 2) is the only host-testable worker logic; Task 3's av wiring is verified by the Task 8 docker e2e — do NOT try to import `camera_worker` in a host test.
- Keep the camera-event dispatch inside its try/catch envelope — a notification failure must never break stats ingest (top constraint).
- The camera event is transient: no alert row, no snapshot, no retry enqueue. Do not route it through `dispatchNotifications` (which is detection-shaped) — use the dedicated `dispatchCameraEvent`.
- `applyCameraState` is extracted from `onStats` purely to make the transition logic testable; `onStats` must still call it for the real Redis-fed path.
