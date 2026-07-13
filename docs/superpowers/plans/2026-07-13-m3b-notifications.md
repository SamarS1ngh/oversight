# M3b Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add web push + Pushover channels, attach a per-alert snapshot image to every notification, and retry failed sends durably — reusing the M3a pipeline.

**Architecture:** The worker writes a per-alert JPEG and sends its path with the detection; the alert row gains `snapshotPath`, served via a signed URL. Web push and Pushover are new `notification_channels.type`s flowing through the existing `filter → cooldown → render → send` path. Snapshot bytes are uploaded to ntfy/Telegram/Pushover (reachability-safe) and passed as a signed URL to webhook/web-push. A failed send is persisted to `notification_deliveries` and retried by a boot-time sweeper with backoff.

**Tech Stack:** Bun + Hono + Drizzle + Postgres (backend); Python/OpenCV (worker); Next.js/React (frontend); `web-push` npm lib; Web Push (VAPID + service worker).

## Global Constraints

- **Non-blocking dispatch preserved:** the M3a guarantee holds — a failing channel, a missing snapshot, or the retry machinery must never break alert persistence or WS fanout. All new work stays inside the existing `dispatchNotifications` try/catch envelope or the boot-time sweeper.
- **Owner-scoped:** every channel + the snapshot route + the subscribe endpoint is scoped to the caller; a non-owner gets 404/403.
- **Additive only:** `alerts.snapshotPath` nullable; new types extend validation, no existing type changes; web push inert until VAPID env set; retry engages only on failure.
- **Snapshot delivery:** ntfy / Telegram / Pushover get **uploaded bytes**; webhook + web push get a **signed snapshot URL** (`${APP_URL}/alerts/<id>/snapshot?token=<sig>`).
- **Retry:** failures-only; backoff `[30s, 2m, 10m, 1h, 6h]`; `dead` after 5 attempts.
- **ntfy priority** low=2/med=3/high=5 (unchanged); **Pushover priority** low=-1/med=0/high=1.
- **Commits:** author is Samar only. NO `Co-Authored-By: Claude` trailer.
- Backend test DB: `DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun test`. DB-backed tests self-skip when Postgres is down (see M3a `test/notify.test.ts`).

---

### Task 1: DB — `alerts.snapshotPath` + `notification_deliveries`

**Files:**
- Modify: `backend/src/db/schema.ts`
- Test: `backend/test/notify.test.ts` (add a schema-smoke assertion)

**Interfaces:**
- Produces: `alerts.snapshotPath` (text, null); `notificationDeliveries` table + `NotifDelivery` type; `notification_channels.type` comment now lists `pushover`, `webpush`.

- [ ] **Step 1: Add the column + table to schema.ts**

In the `alerts` table object, after `severity`:
```ts
    snapshotPath: text("snapshot_path"),
```
After the `notificationChannels` table, add:
```ts
// A failed notification send, persisted for background retry (M3b). Only
// failures land here — the happy path sends inline and writes nothing.
export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => notificationChannels.id, { onDelete: "cascade" }),
    alertId: uuid("alert_id"), // null for a synthetic /test send
    payload: jsonb("payload").notNull(), // render inputs to rebuild the send
    attempts: integer("attempts").notNull().default(1),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("pending"), // pending | sent | dead
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ dueIdx: index("notification_deliveries_due_idx").on(t.status, t.nextAttemptAt) }),
);
```
Update the `notification_channels.type` comment to `// 'webhook' | 'ntfy' | 'telegram' | 'pushover' | 'webpush'`. At the bottom with the other type exports add:
```ts
export type NotifChannel = typeof notificationChannels.$inferSelect;
export type NotifDelivery = typeof notificationDeliveries.$inferSelect;
```
(If `NotifChannel` already exists, leave it.)

- [ ] **Step 2: Apply the migration**

Run: `cd backend && DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bunx drizzle-kit push`
Expected: applies `alter table alerts add column snapshot_path`, creates `notification_deliveries`. Answer any prompt to create the table/column (not rename).

- [ ] **Step 3: Smoke test the new table**

Add to `backend/test/notify.test.ts` (inside the DB-gated section):
```ts
import { notificationDeliveries } from "../src/db/schema";
test("notification_deliveries table is queryable", async () => {
  if (!dbUp) return;
  const rows = await db.select().from(notificationDeliveries).limit(1);
  expect(Array.isArray(rows)).toBe(true);
});
```

- [ ] **Step 4: Run**

Run: `DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun test test/notify.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/db/schema.ts backend/test/notify.test.ts
git commit -m "feat(db): alerts.snapshotPath + notification_deliveries table"
```

---

### Task 2: Snapshot signing (pure, TDD)

**Files:**
- Create: `backend/src/notify/snapshot-token.ts`
- Test: `backend/test/snapshot-token.test.ts`

**Interfaces:**
- Produces: `signSnapshotToken(alertId, nowMs, ttlMs?): string`; `verifySnapshotToken(alertId, token, nowMs): boolean`. HMAC-SHA256 over `${alertId}.${exp}` keyed by `env.JWT_SECRET`; token = `${expMs}.${hexMac}`.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { signSnapshotToken, verifySnapshotToken } from "../src/notify/snapshot-token";

const A = "11111111-1111-1111-1111-111111111111";

test("a fresh token verifies for its alert", () => {
  const t = signSnapshotToken(A, 1000, 60_000);
  expect(verifySnapshotToken(A, t, 2000)).toBe(true);
});
test("a token for another alert is rejected", () => {
  const t = signSnapshotToken(A, 1000, 60_000);
  expect(verifySnapshotToken("22222222-2222-2222-2222-222222222222", t, 2000)).toBe(false);
});
test("an expired token is rejected", () => {
  const t = signSnapshotToken(A, 1000, 60_000);
  expect(verifySnapshotToken(A, t, 1000 + 60_001)).toBe(false);
});
test("a tampered token is rejected", () => {
  const t = signSnapshotToken(A, 1000, 60_000);
  expect(verifySnapshotToken(A, t.replace(/.$/, (c) => (c === "0" ? "1" : "0")), 2000)).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && bun test test/snapshot-token.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
import { createHmac, timingSafeEqual } from "crypto";
import { env } from "../env";

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h

function mac(alertId: string, expMs: number): string {
  return createHmac("sha256", env.JWT_SECRET).update(`${alertId}.${expMs}`).digest("hex");
}

export function signSnapshotToken(alertId: string, nowMs: number, ttlMs = DEFAULT_TTL_MS): string {
  const exp = nowMs + ttlMs;
  return `${exp}.${mac(alertId, exp)}`;
}

export function verifySnapshotToken(alertId: string, token: string, nowMs: number): boolean {
  const dot = token.indexOf(".");
  if (dot < 0) return false;
  const exp = Number(token.slice(0, dot));
  const sig = token.slice(dot + 1);
  if (!Number.isFinite(exp) || exp < nowMs) return false;
  const expected = mac(alertId, exp);
  if (sig.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}
```

- [ ] **Step 4: Run**

Run: `bun test test/snapshot-token.test.ts`
Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/notify/snapshot-token.ts backend/test/snapshot-token.test.ts
git commit -m "feat(api): signed per-alert snapshot tokens (pure)"
```

---

### Task 3: Worker emits a per-alert snapshot + ingest stores it

**Files:**
- Modify: `worker/app/camera_worker.py` (`_emit_one`, `_emit_matches`)
- Modify: `worker/app/config.py` (already has `RECORDINGS_DIR`)
- Modify: `backend/src/realtime/ingest.ts` (`onDetection` values)
- Test: `worker/tests/test_snapshot.py`

**Interfaces:**
- Consumes: the detection frame (`img`/`annotated`) already in `_emit_matches`; `RECORDINGS_DIR`.
- Produces: `events.snapshot_rel(camera_id, detection_id)` (pure, host-testable); detection payload gains `snapshot_path` = `snapshots/<cameraId>/<detectionId>.jpg`; the file is written under `RECORDINGS_DIR`. `alerts.snapshotPath` persisted.

> **Test-env note:** the host `python3` has NO `aiortc`/`av`, so `app.camera_worker` cannot be imported on the host — only the pure modules run in host TDD (this is why M2b tested `tracking_rules`, not the worker). Therefore the **pure** parts (`snapshot_rel`, `detection_event` carrying `snapshot_path`) are host-unit-tested here; the av-coupled `_emit_one` frame-write wiring is verified by the docker e2e in Task 10. Run worker tests with `python3 -m pytest`, never `python`.

- [ ] **Step 1: Write the failing pure test**

`worker/tests/test_snapshot.py` (imports only `app.events` — no av):
```python
import unittest
from app.events import detection_event, snapshot_rel


class TestSnapshot(unittest.TestCase):
    def test_snapshot_rel_layout(self):
        self.assertEqual(snapshot_rel("cam1", "abc"), "snapshots/cam1/abc.jpg")

    def test_detection_event_carries_snapshot_path(self):
        e = detection_event("cam1", 0.9, 1, [], 640, 480, "w1", snapshot_path="snapshots/cam1/x.jpg")
        self.assertEqual(e["snapshot_path"], "snapshots/cam1/x.jpg")

    def test_detection_event_snapshot_path_defaults_none(self):
        e = detection_event("cam1", 0.9, 1, [], 640, 480, "w1")
        self.assertIsNone(e["snapshot_path"])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && python3 -m pytest tests/test_snapshot.py -q`
Expected: FAIL (`snapshot_rel` not defined; `detection_event` has no `snapshot_path`).

- [ ] **Step 3: Add the pure helper + event field in events.py**

In `worker/app/events.py`, add at module level:
```python
import os


def snapshot_rel(camera_id: str, detection_id: str) -> str:
    return os.path.join("snapshots", camera_id, f"{detection_id}.jpg")
```
Add a `snapshot_path: str | None = None` param to `detection_event` and `"snapshot_path": snapshot_path` in its returned dict.

- [ ] **Step 4: Wire the write into camera_worker.py**

Add an injectable writer default in `__init__` (near the other defaults):
```python
        self._snapshot_writer = _default_snapshot_writer
```
At module top (after imports), add:
```python
def _default_snapshot_writer(full_path, bgr):
    import cv2, os
    os.makedirs(os.path.dirname(full_path), exist_ok=True)
    h, w = bgr.shape[:2]
    if w > 640:
        bgr = cv2.resize(bgr, (640, int(h * 640 / w)))  # keep the push payload small
    cv2.imwrite(full_path, bgr, [cv2.IMWRITE_JPEG_QUALITY, 70])
```
Import `snapshot_rel` from `.events`. Change `_emit_one` to take the frame, write the snapshot, and set the path:
```python
    def _emit_one(self, m, w, h, frame) -> str:
        det_id = None
        payload = detection_event(
            self.camera_id, m.confidence, m.count,
            [
                {"x": round(b.x, 4), "y": round(b.y, 4), "w": round(b.w, 4),
                 "h": round(b.h, 4), "conf": b.conf, "label": b.label}
                for b in m.boxes
            ],
            w, h, WORKER_ID,
            label=m.label, rule_id=m.rule_id, severity=m.severity,
        )
        import os
        rel = snapshot_rel(self.camera_id, payload["id"])
        try:
            self._snapshot_writer(os.path.join(RECORDINGS_DIR, rel), frame)
            payload["snapshot_path"] = rel
        except Exception:
            log.exception("snapshot write failed: %s", self.camera_id)
        self._evq.put(("detections", payload))
        return payload["id"]
```
Update both call sites in `_emit_matches` to pass the frame (`annotated`):
```python
            eid = self._emit_one(m, w, h, annotated)
```
(both the presence loop and the tracking loop).

- [ ] **Step 5: Store it in ingest.ts**

In `backend/src/realtime/ingest.ts` `onDetection`, add to the `.values({...})`:
```ts
        snapshotPath: d.snapshot_path ?? null,
```

- [ ] **Step 6: Run the pure worker test**

Run: `cd worker && python3 -m pytest tests/test_snapshot.py -q`
Expected: pass (3 tests). The `_emit_one` frame-write wiring is verified in Task 10's docker e2e.

- [ ] **Step 7: Commit**

```bash
git add worker/app/camera_worker.py worker/app/events.py backend/src/realtime/ingest.ts worker/tests/test_snapshot.py
git commit -m "feat(worker): per-alert snapshot jpeg + ingest stores snapshotPath"
```

---

### Task 4: Serve the snapshot + `snapshotUrl` helper

**Files:**
- Modify: `backend/src/alerts/routes.ts` (export a second, un-authed `snapshotRoutes`)
- Modify: `backend/src/app.ts` (mount `snapshotRoutes`)
- Create: `backend/src/notify/snapshot-url.ts`
- Test: `backend/test/notify.test.ts` (add snapshot-route cases)

**Interfaces:**
- Consumes: `verifySnapshotToken`, `alerts.snapshotPath`, `env.RECORDINGS_DIR`, `env.APP_URL`.
- Produces: `GET /alerts/:id/snapshot?token=` → `image/jpeg`; `snapshotUrl(alertId, nowMs): string`.

> **Why a separate router:** `alerts/routes.ts` does `alertRoutes.use("*", requireAuth)` (line 11) — a blanket Bearer gate on every alert route. External push services and `<img>` tags can't send a Bearer header, so the snapshot route must live on its OWN Hono instance (`snapshotRoutes`) with no `requireAuth`; the signed token IS its auth. Both routers mount at `/alerts` — Hono keeps each instance's middleware to itself.

- [ ] **Step 1: Implement the URL helper**

`backend/src/notify/snapshot-url.ts`:
```ts
import { env } from "../env";
import { signSnapshotToken } from "./snapshot-token";

export function snapshotUrl(alertId: string, nowMs: number): string {
  return `${env.APP_URL}/alerts/${alertId}/snapshot?token=${signSnapshotToken(alertId, nowMs)}`;
}
```

- [ ] **Step 2: Add the serving route on its own router**

In `backend/src/alerts/routes.ts`, add `join` from `path`, `verifySnapshotToken` from `../notify/snapshot-token`, and export a NEW un-authed router (do NOT attach it to `alertRoutes`):
```ts
export const snapshotRoutes = new Hono();
snapshotRoutes.get("/:id/snapshot", async (c) => {
  const id = c.req.param("id");
  const token = c.req.query("token") ?? "";
  if (!verifySnapshotToken(id, token, Date.now())) return c.json({ error: "forbidden" }, 403);
  const [a] = await db.select({ p: alerts.snapshotPath }).from(alerts).where(eq(alerts.id, id)).limit(1);
  if (!a?.p) return c.json({ error: "not found" }, 404);
  const file = Bun.file(join(env.RECORDINGS_DIR, a.p));
  if (!(await file.exists())) return c.json({ error: "not found" }, 404);
  return new Response(file, { headers: { "content-type": "image/jpeg" } });
});
```
Then in `backend/src/app.ts`, import and mount it at `/alerts` (a second router on the same base — its handlers coexist with `alertRoutes`, and it has no `requireAuth`):
```ts
import { alertRoutes, snapshotRoutes } from "./alerts/routes";
// ... with the other mounts:
app.route("/alerts", snapshotRoutes);
```
Keep the existing `app.route("/alerts", alertRoutes)` line. Register `snapshotRoutes` so `/alerts/:id/snapshot` resolves without a Bearer header.

- [ ] **Step 3: Tests**

Add to `backend/test/notify.test.ts` (DB-gated). Write a fixture JPEG under `RECORDINGS_DIR`:
```ts
import { signSnapshotToken } from "../src/notify/snapshot-token";
import { alerts, cameras } from "../src/db/schema";
import { env } from "../src/env";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

test("snapshot route serves the jpeg for a valid token, 403/404 otherwise", async () => {
  if (!dbUp) return;
  const a = await nuser();
  const cam = await (await a(`/cameras`, json({ name: "snapcam", rtspUrl: "rtsp://x" }))).json();
  const alertId = "33333333-3333-3333-3333-333333333331";
  const rel = `snapshots/${cam.id}/${alertId}.jpg`;
  mkdirSync(join(env.RECORDINGS_DIR, "snapshots", cam.id), { recursive: true });
  writeFileSync(join(env.RECORDINGS_DIR, rel), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  await db.insert(alerts).values({ id: alertId, cameraId: cam.id, ts: new Date(), confidence: 0.9, count: 1, snapshotPath: rel }).onConflictDoNothing();
  const good = signSnapshotToken(alertId, Date.now());
  const ok = await call(`/alerts/${alertId}/snapshot?token=${good}`);
  expect(ok.status).toBe(200);
  expect(ok.headers.get("content-type")).toBe("image/jpeg");
  expect((await call(`/alerts/${alertId}/snapshot?token=bad`)).status).toBe(403);
});
```
(If `RECORDINGS_DIR` is `/recordings` and not writable in the test env, set `RECORDINGS_DIR` to a temp dir via env for this test run, or skip the file-write assertion and assert 403 only. Prefer pointing `env.RECORDINGS_DIR` at `Bun`'s tmp for the suite.)

- [ ] **Step 4: Run**

Run: `RECORDINGS_DIR=/tmp/vms-rec DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun test test/notify.test.ts`
Expected: pass (route serves jpeg, rejects bad token).

- [ ] **Step 5: Commit**

```bash
git add backend/src/alerts/routes.ts backend/src/app.ts backend/src/notify/snapshot-url.ts backend/test/notify.test.ts
git commit -m "feat(api): serve per-alert snapshot via signed URL"
```

---

### Task 5: Pushover driver (pure, TDD)

**Files:**
- Modify: `backend/src/notify/render.ts` (pushover render branch)
- Modify: `backend/src/notify/drivers.ts` (pushover buildRequest branch)
- Modify: `backend/src/notify/routes.ts` (`validateChannel` pushover)
- Test: `backend/test/notify.test.ts`

**Interfaces:**
- Produces: `renderAlert("pushover", …)` → `{ title, message, priority, url }` (priority low=-1/med=0/high=1); `buildRequest("pushover", config, payload)` → POST `https://api.pushover.net/1/messages.json`, form body with `token`, `user`, `title`, `message`, `priority`, `url`.

- [ ] **Step 1: Write the failing tests**

```ts
test("renderAlert pushover maps severity to priority + carries url", () => {
  const p: any = renderAlert("pushover", ALERT, "Driveway", "Night", LINK);
  expect(p.priority).toBe(1); // high
  expect(p.url).toBe(LINK);
  expect(p.title).toContain("Driveway");
});
test("buildRequest pushover posts a form to the messages API", () => {
  const r = buildRequest("pushover", { token: "APP", user: "USR" }, { title: "T", message: "M", priority: 1, url: LINK });
  expect(r.url).toBe("https://api.pushover.net/1/messages.json");
  expect(r.headers["content-type"]).toContain("application/x-www-form-urlencoded");
  const body = new URLSearchParams(r.body);
  expect(body.get("token")).toBe("APP");
  expect(body.get("user")).toBe("USR");
  expect(body.get("priority")).toBe("1");
});
test("validateChannel: pushover needs token + user", async () => {
  if (!dbUp) return;
  const a = await nuser();
  expect((await a(`/notifications`, json({ type: "pushover", name: "po", config: { token: "x" } }))).status).toBe(400);
  expect((await a(`/notifications`, json({ type: "pushover", name: "po", config: { token: "x", user: "y" } }))).status).toBe(201);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && bun test test/notify.test.ts`
Expected: FAIL on the three new cases.

- [ ] **Step 3: Implement**

`render.ts` — add before the telegram fallthrough:
```ts
  if (type === "pushover") {
    const PO: Record<string, number> = { low: -1, medium: 0, high: 1 };
    const time = new Date(alert.ts).toLocaleString();
    return {
      title: `${cameraName}: ${sev} ${label}`,
      message: `${rule} · ${alert.count} · ${time}`,
      priority: PO[sev] ?? 0,
      url: link,
    };
  }
```
`drivers.ts` — add a pushover branch in `buildRequest` before telegram:
```ts
  if (type === "pushover") {
    const body = new URLSearchParams({
      token: config.token, user: config.user,
      title: String(payload.title), message: String(payload.message),
      priority: String(payload.priority), url: String(payload.url),
    });
    return { url: "https://api.pushover.net/1/messages.json", method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() };
  }
```
`routes.ts` `validateChannel` — add to `TYPES` `"pushover"` and after the telegram config check:
```ts
  if (b.type === "pushover" && (!cfg.token || !cfg.user)) return "pushover config needs token + user";
```

- [ ] **Step 4: Run**

Run: `bun test test/notify.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/notify/render.ts backend/src/notify/drivers.ts backend/src/notify/routes.ts backend/test/notify.test.ts
git commit -m "feat(api): pushover notification channel (pure render+build+validate)"
```

---

### Task 6: Attach the snapshot across sends (bytes-upload + URL)

**Files:**
- Modify: `backend/src/notify/drivers.ts` (new `sendChannel`; upload variants)
- Modify: `backend/src/notify/render.ts` (webhook `snapshotUrl`)
- Modify: `backend/src/notify/dispatch.ts` (read snapshot bytes once, pass down)
- Test: `backend/test/notify.test.ts` (capture-server upload assertions)

**Interfaces:**
- Produces: `sendChannel(type, config, payload, snapshot?): Promise<{ok, status}>` where `snapshot = { bytes: Uint8Array, url: string } | null`. Uploads bytes for ntfy/telegram/pushover; webhook uses the URL (already in payload); web push handled in Task 7. Keeps `buildRequest`/`send` for the text path.
- Consumes: `snapshotUrl` (Task 4), `alerts.snapshotPath`.

- [ ] **Step 1: Write the failing test (capture-server sees the bytes)**

```ts
test("ntfy send uploads snapshot bytes as the body when a snapshot exists", async () => {
  const { sendChannel } = await import("../src/notify/drivers");
  let gotBody: ArrayBuffer | null = null; let title: string | null = null;
  const server = Bun.serve({ port: 0, async fetch(req) { title = req.headers.get("Title"); gotBody = await req.arrayBuffer(); return new Response("ok"); } });
  const payload: any = { title: "T", body: "B", priority: 5, tags: ["high"], click: "http://l" };
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const res = await sendChannel("ntfy", { server: `http://127.0.0.1:${server.port}`, topic: "t" }, payload, { bytes, url: "http://snap" });
  expect(res.ok).toBe(true);
  expect(new Uint8Array(gotBody!)).toEqual(bytes);
  expect(title).toBe("T");
  server.stop();
});
test("webhook payload gains snapshotUrl when a snapshot exists", () => {
  const p: any = renderAlert("webhook", ALERT, "Cam", "R", LINK, "http://snap/x.jpg");
  expect(p.snapshotUrl).toBe("http://snap/x.jpg");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/notify.test.ts`
Expected: FAIL (`sendChannel` not exported; `renderAlert` 6th arg ignored).

- [ ] **Step 3: Implement**

`render.ts` — extend the signature and the webhook branch:
```ts
export function renderAlert(type, alert, cameraName, ruleName, link, snapshotUrl?: string | null) { ... }
```
In the webhook return object add `snapshotUrl: snapshotUrl ?? null,`.

`drivers.ts` — add `sendChannel`. For ntfy-with-bytes, message/title/priority ride in headers and the JPEG is the body; for telegram-with-bytes, POST `sendPhoto` multipart with `photo` + `caption`; for pushover-with-bytes, POST multipart with `attachment`; everything else defers to `buildRequest`+`send`:
```ts
export async function sendChannel(type: string, config: any, payload: any, snapshot?: { bytes: Uint8Array; url: string } | null): Promise<{ ok: boolean; status: number }> {
  if (snapshot && type === "ntfy") {
    const server = (config.server ?? "https://ntfy.sh").replace(/\/$/, "");
    const headers: Record<string, string> = {
      Title: String(payload.title), Message: String(payload.body),
      Priority: String(payload.priority), Tags: (payload.tags ?? []).join(","),
      Click: String(payload.click), Filename: "snapshot.jpg",
    };
    if (config.token) headers["Authorization"] = `Bearer ${config.token}`;
    const res = await fetch(`${server}/${config.topic}`, { method: "POST", headers, body: snapshot.bytes, signal: AbortSignal.timeout(5000) });
    return { ok: res.ok, status: res.status };
  }
  if (snapshot && type === "telegram") {
    const fd = new FormData();
    fd.set("chat_id", config.chatId);
    fd.set("caption", String(payload.text));
    fd.set("parse_mode", "Markdown");
    fd.set("photo", new Blob([snapshot.bytes], { type: "image/jpeg" }), "snapshot.jpg");
    const res = await fetch(`https://api.telegram.org/bot${config.botToken}/sendPhoto`, { method: "POST", body: fd, signal: AbortSignal.timeout(5000) });
    return { ok: res.ok, status: res.status };
  }
  if (snapshot && type === "pushover") {
    const fd = new FormData();
    for (const [k, v] of new URLSearchParams(buildRequest("pushover", config, payload).body)) fd.set(k, v);
    fd.set("attachment", new Blob([snapshot.bytes], { type: "image/jpeg" }), "snapshot.jpg");
    const res = await fetch("https://api.pushover.net/1/messages.json", { method: "POST", body: fd, signal: AbortSignal.timeout(5000) });
    return { ok: res.ok, status: res.status };
  }
  return send(buildRequest(type, config, payload));
}
```

`dispatch.ts` — read the snapshot once (bytes + signed URL) and thread it through. After computing `link`:
```ts
import { promises as fs } from "fs";
import { join } from "path";
import { alerts } from "../db/schema";
import { snapshotUrl } from "./snapshot-url";
import { sendChannel } from "./drivers";
// ... inside dispatchNotifications, after `link`:
    let snap: { bytes: Uint8Array; url: string } | null = null;
    if (alert.snapshot_path) {
      try {
        const bytes = new Uint8Array(await fs.readFile(join(env.RECORDINGS_DIR, alert.snapshot_path)));
        snap = { bytes, url: snapshotUrl(alert.id, now) };
      } catch { snap = null; }
    }
```
Change the per-channel send to:
```ts
        const payload = renderAlert(ch.type, alert, cameraName, ruleName, link, snap?.url ?? null);
        await sendChannel(ch.type, ch.config, payload, snap);
```
(Import `env` is already present. Drop the now-unused `buildRequest`/`send` imports if the linter complains, or keep them — `sendChannel` uses them.)

- [ ] **Step 4: Run**

Run: `DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun test test/notify.test.ts`
Expected: pass (ntfy upload + webhook snapshotUrl).

- [ ] **Step 5: Commit**

```bash
git add backend/src/notify/drivers.ts backend/src/notify/render.ts backend/src/notify/dispatch.ts backend/test/notify.test.ts
git commit -m "feat(api): attach snapshot to sends (bytes upload + webhook url)"
```

---

### Task 7: Web push channel

**Files:**
- Modify: `backend/package.json` (add `web-push`)
- Create: `backend/scripts/gen-vapid.ts`
- Modify: `backend/src/env.ts` (VAPID vars)
- Modify: `backend/src/notify/routes.ts` (`vapid-public-key` endpoint + `webpush` validate)
- Modify: `backend/src/notify/drivers.ts` (`sendChannel` webpush branch + 410 signal)
- Modify: `backend/src/notify/dispatch.ts` (delete channel on webpush-expired)
- Test: `backend/test/notify.test.ts` (payload shaping + 410 branch, mocked)

**Interfaces:**
- Produces: `GET /notifications/vapid-public-key` → `{ key }`; `sendChannel("webpush", config, payload, snapshot)` uses the `web-push` lib and throws a tagged error `WEBPUSH_GONE` on 404/410; dispatch deletes the channel on that tag (no delivery row).

- [ ] **Step 1: Add the dependency + gen script**

Run: `cd backend && bun add web-push`
`backend/scripts/gen-vapid.ts`:
```ts
import webpush from "web-push";
const k = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${k.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${k.privateKey}`);
console.log(`VAPID_SUBJECT=mailto:admin@example.com`);
```

- [ ] **Step 2: env vars**

In `backend/src/env.ts` add:
```ts
  VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY ?? "",
  VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY ?? "",
  VAPID_SUBJECT: process.env.VAPID_SUBJECT ?? "mailto:admin@example.com",
```

- [ ] **Step 3: routes — public key + validation**

In `routes.ts`, add `"webpush"` to `TYPES`, add to `validateChannel`:
```ts
  if (b.type === "webpush" && (!cfg.endpoint || !cfg.p256dh || !cfg.auth)) return "webpush config needs a subscription";
```
Add the endpoint (before the auth-gated routes if the key should be readable pre-config; the frontend needs it while logged in, so it can stay behind `requireAuth`):
```ts
notifyRoutes.get("/vapid-public-key", (c) => c.json({ key: env.VAPID_PUBLIC_KEY }));
```

- [ ] **Step 4: sendChannel webpush branch**

In `drivers.ts`, add at the top of `sendChannel`:
```ts
  if (type === "webpush") {
    const webpush = (await import("web-push")).default;
    webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
    const sub = { endpoint: config.endpoint, keys: { p256dh: config.p256dh, auth: config.auth } };
    const data = JSON.stringify({ title: payload.title, body: payload.body, image: snapshot?.url ?? null, click: payload.click });
    try {
      const r = await webpush.sendNotification(sub as any, data);
      return { ok: true, status: r.statusCode };
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) { const err: any = new Error("WEBPUSH_GONE"); err.gone = true; throw err; }
      throw e;
    }
  }
```
Import `env` in drivers.ts. Add a `webpush` render branch in `render.ts` returning `{ title, body, click }` (reuse the ntfy shape: `title`, `body`, `click`).

- [ ] **Step 5: dispatch deletes gone subscriptions**

In `dispatch.ts` per-channel `catch`, before logging:
```ts
      } catch (e: any) {
        if (e?.gone) { await db.delete(notificationChannels).where(eq(notificationChannels.id, ch.id)).catch(() => {}); continue; }
        // ... existing enqueue (Task 8) + log
      }
```

- [ ] **Step 6: Tests (mock the lib)**

Unit-test the render shape + the 410→gone branch by monkeypatching `web-push` import is awkward; instead test the dispatch delete-on-gone path with a fake: assert `renderAlert("webpush", …)` returns `{title, body, click}`, and add a DB test that a `webpush` channel with a bad endpoint, when its send throws `gone`, is removed. Keep it light:
```ts
test("renderAlert webpush yields title/body/click", () => {
  const p: any = renderAlert("webpush", ALERT, "Cam", "R", LINK);
  expect(p.title).toContain("Cam"); expect(p.click).toBe(LINK);
});
```
(The real push send + 410 deletion is covered by the live e2e — a real expired subscription — in Task 10.)

- [ ] **Step 7: Run**

Run: `bun test test/notify.test.ts`
Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add backend/package.json backend/bun.lockb backend/scripts/gen-vapid.ts backend/src/env.ts backend/src/notify/routes.ts backend/src/notify/drivers.ts backend/src/notify/render.ts backend/src/notify/dispatch.ts backend/test/notify.test.ts
git commit -m "feat(api): web push channel (VAPID + web-push, expire on 410)"
```

---

### Task 8: Durable retry queue (enqueue on failure + sweeper)

**Files:**
- Create: `backend/src/notify/retry.ts` (backoff + sweeper)
- Modify: `backend/src/notify/dispatch.ts` (enqueue a failed send)
- Modify: `backend/src/index.ts` (`startNotifyRetry()`)
- Test: `backend/test/notify-retry.test.ts`

**Interfaces:**
- Produces: `nextDelayMs(attempts): number` (backoff `[30s,2m,10m,1h,6h]`, capped); `enqueueFailure(channelId, alertId, inputs, errMsg, nowMs)`; `sweepOnce(nowMs, sender?)` claims due `pending`, re-sends, transitions; `startNotifyRetry()` (setInterval).
- `inputs` = `{ type, config, alert, cameraName, ruleName, link }` — enough to re-render + re-send (snapshot re-read from `alert.snapshot_path`).

- [ ] **Step 1: Write the failing test (backoff + transitions)**

`backend/test/notify-retry.test.ts`:
```ts
import { test, expect, beforeAll } from "bun:test";
import { sql } from "drizzle-orm";
import { nextDelayMs, enqueueFailure, sweepOnce } from "../src/notify/retry";
import { db } from "../src/db";
import { notificationChannels, notificationDeliveries } from "../src/db/schema";

test("backoff grows then caps at the last step", () => {
  expect(nextDelayMs(1)).toBe(30_000);
  expect(nextDelayMs(2)).toBe(120_000);
  expect(nextDelayMs(5)).toBe(6 * 3600_000);
  expect(nextDelayMs(99)).toBe(6 * 3600_000);
});

let dbUp = false;
beforeAll(async () => { try { await db.execute(sql`select 1`); dbUp = true; } catch { dbUp = false; } });

async function seedChannel() {
  const [u] = await db.execute(sql`insert into users (username, password_hash) values (${"r_" + Math.random().toString(36).slice(2)}, 'x') returning id`) as any;
  const [ch] = await db.insert(notificationChannels).values({ userId: (u as any).id, type: "webhook", name: "r", config: { url: "http://127.0.0.1:1/x" } }).returning();
  return ch;
}

test("a due pending row re-sends; success marks sent", async () => {
  if (!dbUp) return;
  const ch = await seedChannel();
  await enqueueFailure(ch.id, null, { type: "webhook", config: ch.config, alert: { id: "a", camera_id: "c", ts: new Date().toISOString(), count: 1, confidence: 1, severity: "low" }, cameraName: "c", ruleName: null, link: "http://l" }, "boom", 0);
  const [row] = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.channelId, ch.id));
  expect(row.status).toBe("pending");
  await sweepOnce(1000, async () => ({ ok: true, status: 200 }));
  const [after] = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.channelId, ch.id));
  expect(after.status).toBe("sent");
});

test("a failing send bumps attempts + backoff, dead at 5", async () => {
  if (!dbUp) return;
  const ch = await seedChannel();
  await enqueueFailure(ch.id, null, { type: "webhook", config: ch.config, alert: { id: "a2", camera_id: "c", ts: new Date().toISOString(), count: 1, confidence: 1, severity: "low" }, cameraName: "c", ruleName: null, link: "http://l" }, "boom", 0);
  let now = 0;
  for (let i = 0; i < 5; i++) { now += 7 * 3600_000; await sweepOnce(now, async () => { throw new Error("still down"); }); }
  const [dead] = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.channelId, ch.id));
  expect(dead.status).toBe("dead");
  expect(dead.attempts).toBeGreaterThanOrEqual(5);
});
```
(Add `import { eq } from "drizzle-orm";`.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun test test/notify-retry.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement retry.ts**

```ts
import { and, eq, lte } from "drizzle-orm";
import { promises as fs } from "fs";
import { join } from "path";
import { db } from "../db";
import { notificationDeliveries } from "../db/schema";
import { env } from "../env";
import { renderAlert } from "./render";
import { sendChannel } from "./drivers";
import { snapshotUrl } from "./snapshot-url";

const BACKOFF = [30_000, 120_000, 600_000, 3_600_000, 6 * 3_600_000];
export function nextDelayMs(attempts: number): number { return BACKOFF[Math.min(attempts, BACKOFF.length) - 1]; }

export async function enqueueFailure(channelId: string, alertId: string | null, inputs: any, errMsg: string, nowMs: number): Promise<void> {
  await db.insert(notificationDeliveries).values({
    channelId, alertId, payload: inputs, attempts: 1,
    nextAttemptAt: new Date(nowMs + BACKOFF[0]), status: "pending", lastError: errMsg,
  }).catch((e) => console.error("[notify] enqueue failed:", (e as Error).message));
}

type Sender = (inputs: any) => Promise<{ ok: boolean; status: number }>;

async function realSend(inputs: any): Promise<{ ok: boolean; status: number }> {
  let snap: { bytes: Uint8Array; url: string } | null = null;
  if (inputs.alert?.snapshot_path) {
    try { snap = { bytes: new Uint8Array(await fs.readFile(join(env.RECORDINGS_DIR, inputs.alert.snapshot_path))), url: snapshotUrl(inputs.alert.id, Date.now()) }; } catch {}
  }
  const payload = renderAlert(inputs.type, inputs.alert, inputs.cameraName, inputs.ruleName, inputs.link, snap?.url ?? null);
  return sendChannel(inputs.type, inputs.config, payload, snap);
}

export async function sweepOnce(nowMs: number, sender: Sender = realSend): Promise<void> {
  const due = await db.select().from(notificationDeliveries)
    .where(and(eq(notificationDeliveries.status, "pending"), lte(notificationDeliveries.nextAttemptAt, new Date(nowMs))))
    .limit(20);
  for (const row of due) {
    // claim: guarded update so a concurrent tick can't double-send
    const claimed = await db.update(notificationDeliveries).set({ status: "sending" })
      .where(and(eq(notificationDeliveries.id, row.id), eq(notificationDeliveries.status, "pending"))).returning();
    if (claimed.length === 0) continue;
    try {
      const res = await sender(row.payload);
      if (!res.ok) throw new Error(`status ${res.status}`);
      await db.update(notificationDeliveries).set({ status: "sent" }).where(eq(notificationDeliveries.id, row.id));
    } catch (e) {
      const attempts = row.attempts + 1;
      const dead = attempts >= 5;
      await db.update(notificationDeliveries).set({
        status: dead ? "dead" : "pending", attempts,
        nextAttemptAt: new Date(nowMs + nextDelayMs(attempts)), lastError: (e as Error).message,
      }).where(eq(notificationDeliveries.id, row.id));
    }
  }
}

export function startNotifyRetry(): void {
  setInterval(() => { void sweepOnce(Date.now()); }, 15_000);
  console.log("[notify] retry sweeper started");
}
```
(Note: `sweepOnce` claims to `sending` then re-reads via the `row` in-memory copy; on failure it writes back `pending`/`dead`. The test's 5-iteration loop reaches `dead`.)

- [ ] **Step 4: Enqueue on failure in dispatch.ts**

In the per-channel `catch` (after the `gone` handling), replace the bare log with an enqueue + log:
```ts
      } catch (e: any) {
        if (e?.gone) { await db.delete(notificationChannels).where(eq(notificationChannels.id, ch.id)).catch(() => {}); continue; }
        console.error(`[notify] channel ${ch.id} (${ch.type}) failed:`, (e as Error).message);
        await enqueueFailure(ch.id, alert.id ?? null, { type: ch.type, config: ch.config, alert, cameraName, ruleName, link }, (e as Error).message, now).catch(() => {});
      }
```
Import `enqueueFailure` from `./retry`.

- [ ] **Step 5: Start the sweeper in index.ts**

```ts
import { startNotifyRetry } from "./notify/retry";
// after startRetention();
startNotifyRetry();
```

- [ ] **Step 6: Run**

Run: `DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun test test/notify-retry.test.ts`
Expected: pass (backoff + sent + dead-at-5).

- [ ] **Step 7: Commit**

```bash
git add backend/src/notify/retry.ts backend/src/notify/dispatch.ts backend/src/index.ts backend/test/notify-retry.test.ts
git commit -m "feat(api): durable retry queue for failed notifications"
```

---

### Task 9: Frontend — Pushover + web push subscribe + service worker

**Files:**
- Modify: `frontend/lib/types.ts` (`NotifChannelType` add `pushover`, `webpush`)
- Modify: `frontend/lib/api.ts` (`vapidPublicKey`, `subscribeWebPush`)
- Modify: `frontend/app/notifications/page.tsx` (Pushover fields + Enable-push button + webpush row)
- Create: `frontend/public/sw.js`
- Test: `npm run build`

**Interfaces:**
- Consumes: `GET /notifications/vapid-public-key`; `POST /notifications` with `{ type:"webpush", config:{endpoint,p256dh,auth} }`.

- [ ] **Step 1: Types**

`NotifChannelType = "webhook" | "ntfy" | "telegram" | "pushover" | "webpush";`

- [ ] **Step 2: api.ts**

```ts
  vapidPublicKey: () => req("/notifications/vapid-public-key"),
```
Add a helper (in api.ts or the page) `subscribeWebPush()` that registers `/sw.js`, fetches the key, subscribes, and POSTs the channel. Put it in the page (needs `navigator`).

- [ ] **Step 3: Service worker**

`frontend/public/sw.js`:
```js
self.addEventListener("push", (e) => {
  const d = e.data ? e.data.json() : {};
  e.waitUntil(self.registration.showNotification(d.title || "Alert", {
    body: d.body || "", image: d.image || undefined, data: { click: d.click || "/" },
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(clients.openWindow(e.notification.data?.click || "/"));
});
```

- [ ] **Step 4: Page — Pushover config fields + Enable-push button**

Add to `CONFIG_FIELDS`: `pushover: ["token", "user"]`. Add `"pushover"` to `TYPES` (but NOT `webpush` — that's created via the button, not the form). Add a button above the form:
```tsx
<button className="btn" onClick={enablePush}>Enable push on this browser</button>
```
Implement `enablePush`:
```tsx
async function enablePush() {
  setErr(null);
  try {
    if (!("serviceWorker" in navigator)) throw new Error("no service worker support");
    const reg = await navigator.serviceWorker.register("/sw.js");
    const { key } = await api.vapidPublicKey();
    if (!key) throw new Error("web push not configured on the server (set VAPID env)");
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(key) });
    const j = sub.toJSON();
    await api.createChannel({ type: "webpush", name: "This browser", config: { endpoint: j.endpoint, p256dh: j.keys!.p256dh, auth: j.keys!.auth }, minSeverity: "low", cameraIds: null, cooldownSecs: 60, enabled: true });
    load();
  } catch (e: any) { setErr(e.message); }
}
function urlB64ToUint8(s: string) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...b].map((c) => c.charCodeAt(0)));
}
```
Render webpush rows fine via the existing map (type badge shows `webpush`; config fields hidden since it's not selectable in the form).

- [ ] **Step 5: Build**

Run: `cd frontend && npm run build`
Expected: compiles; `/notifications` in the route list; `sw.js` served from `public/`.

- [ ] **Step 6: Commit**

```bash
git add frontend/lib/types.ts frontend/lib/api.ts frontend/app/notifications/page.tsx frontend/public/sw.js
git commit -m "feat(web): pushover config + enable-push button + service worker"
```

---

### Task 10: Docs + full suites + docker e2e

**Files:**
- Modify: `.env.example` (VAPID vars), `README.md`
- Verify: all suites + live stack

- [ ] **Step 1: Docs**

`.env.example`: add `VAPID_PUBLIC_KEY=`, `VAPID_PRIVATE_KEY=`, `VAPID_SUBJECT=mailto:admin@example.com` with a comment: generate via `bun run backend/scripts/gen-vapid.ts`. README: note web push needs VAPID env + HTTPS (or localhost) for the service worker; notifications now carry the detection snapshot.

- [ ] **Step 2: Full suites**

Run: `cd backend && DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun test` → all pass.
Run: `cd worker && python3 -m pytest -q` → all pass (host runs the pure suite only; camera_worker needs the docker image).
Run: `cd frontend && npm run build` → clean.

- [ ] **Step 3: SKIP — docker e2e is run by the controller**

The controller rebuilds `worker backend`, sets VAPID env, and verifies: real detection → `alerts.snapshotPath` set + snapshot fetchable via signed URL; ntfy/webhook receive the image (capture server); a dead endpoint yields a `notification_deliveries` row that retries then goes `dead`; alert persistence unaffected. Browser web-push subscribe is verified manually.

- [ ] **Step 4: Commit**

```bash
git add .env.example README.md
git commit -m "docs: web push (VAPID) + snapshot notifications; M3b verified"
```

---

## Notes for the executor

- The M3a pipeline is the backbone — reuse `filter`/`cooldown`/`renderAlert`; do not fork a parallel dispatch.
- Keep every new failure path inside `dispatchNotifications`'s try/catch or the sweeper — the non-blocking guarantee is the top constraint.
- `web-push` runs in Bun via Node crypto; if `bun add web-push` surfaces a runtime issue, the fallback is manual RFC-8291 encryption — flag it rather than block.
- The snapshot route is intentionally token-authed (not session-authed) so external push services fetch it; never widen it to serve arbitrary paths — it only reads `alerts.snapshotPath` for a verified alert id.
