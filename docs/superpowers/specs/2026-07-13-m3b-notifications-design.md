# M3b — Web Push + Inline Snapshot + Pushover + Durable Retry

**Date:** 2026-07-13
**Milestone:** M3b of the [OSS VMS roadmap](./2026-07-04-oss-vms-product-roadmap.md)
**Goal:** Finish the notification story started in M3a. Add two new delivery
channels (**web push**, **Pushover**), attach the **detection snapshot image**
to every notification, and make delivery **durable** — a transient failure is
retried in the background instead of lost. Email/SMTP is explicitly out.

## Scope

**In:** a per-alert snapshot (worker-emitted, always present) attached to every
channel's notification; **web push** (VAPID + service worker + browser subscribe
flow); **Pushover** as a fourth push channel; a **failures-only durable retry
queue** (persist a failed send, retry with backoff, give up after 5 tries).
Everything reuses the M3a pipeline (`filter → cooldown → render → send`) — web
push and Pushover are new channel `type`s, not a parallel system.

**Out (M3a already shipped):** webhook, ntfy, Telegram; the cooldown; the
config UI shell. **Out entirely:** email/SMTP; a full outbox (we persist only
failures, not every send); multi-node/distributed retry (single self-hosted
node assumed).

## Decisions locked (from brainstorming)

- **Snapshot source = worker-emitted per-alert JPEG.** The worker already holds
  the detection frame; it writes a downscaled JPEG and sends its path with the
  detection. New `alerts.snapshotPath`. Always present at dispatch time,
  decoupled from clips/recording (a clip's thumb is racy — it lands after
  post-roll and only when a rule records).
- **Snapshot delivery is reachability-safe.** ntfy / Telegram / Pushover get the
  **raw image bytes uploaded** (so a self-hosted box behind NAT still delivers
  the picture). Webhook and web push get a **signed snapshot URL** — webhook's
  receiver and the in-browser service worker both fetch it themselves.
- **Retry = failures-only, DB-backed.** Inline send stays fast; only a failed
  send is persisted to `notification_deliveries` and retried by a background
  sweeper. Backoff `[30s, 2m, 10m, 1h, 6h]`, then `dead`.
- **Web push and Pushover are channel `type`s** in the existing
  `notification_channels` table, flowing through the same
  filter/cooldown/render/dispatch/retry path.
- **VAPID keys** generated once and stored in env; the frontend reads the public
  key from an endpoint. A subscription is auto-created as a `webpush` channel row
  by the browser subscribe button (not hand-configured).
- **Expired web push subscription (HTTP 404/410 Gone)** → delete that channel.

## Data model

```
alerts.snapshotPath   text  NULL          -- rel path to the per-alert JPEG

notification_channels.type  -- now: webhook | ntfy | telegram | pushover | webpush
  pushover config: { token, user }               -- app token + user/group key
  webpush  config: { endpoint, p256dh, auth }    -- auto-filled by subscribe

notification_deliveries                    -- NEW (failures-only retry queue)
  id            uuid pk default random
  channelId     uuid -> notification_channels.id (cascade delete)
  alertId       uuid NULL                  -- null for a synthetic /test send
  payload       jsonb not null             -- render inputs to rebuild the send
  attempts      integer not null default 1
  nextAttemptAt timestamptz not null
  status        text not null default 'pending'   -- pending | sent | dead
  lastError     text
  createdAt     timestamptz default now
  index (status, nextAttemptAt)
```

`payload` stores the render inputs (type, config snapshot, rendered alert
fields, link, snapshot path) so the sweeper can rebuild and re-send without
re-reading the (possibly deleted) alert.

## Feature 1 — inline snapshot

### Worker
On a detection that yields an alert, downscale the frame (reuse the existing
`thumb_bgr`) and `cv2.imwrite` to `snapshots/<cameraId>/<uuid>.jpg` under the
recordings dir; add `snapshot_path` to the detection POST body. Independent of
the recorder/clip path — every alert gets one.

### Backend
- Ingest stores `snapshot_path` → `alerts.snapshotPath` (snake→camel).
- `GET /alerts/:id/snapshot?token=<signed>` → streams `image/jpeg`. The token is
  an HMAC of `alertId + exp` signed with the app secret, short TTL (e.g. 1h),
  verified before serving — so external push services and the browser fetch it
  without a session. 404 if no snapshot.
- `snapshotUrl(alertId)` helper → `${APP_URL}/alerts/<id>/snapshot?token=<signed>`.

### Attach per channel (in render / send)
- **webhook** → add `snapshotUrl` (signed) to the JSON payload.
- **ntfy** → upload bytes: POST the file as the body with `Filename` header;
  message/title/priority stay in headers.
- **telegram** → `sendPhoto` (multipart) with the file bytes + caption =
  the rendered text; falls back to `sendMessage` if no snapshot.
- **pushover** → multipart `attachment` field with the file bytes.
- **webpush** → signed `snapshotUrl` in the push data; the SW shows it via the
  `image` option of `showNotification`.

## Feature 2 — web push

### Keys / config
- `bun run gen-vapid` (a small script) prints a VAPID keypair; operator puts
  `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (a `mailto:`) in
  `.env`. `env.ts` reads them; web push is disabled (skipped) if unset.
- `GET /notifications/vapid-public-key` → `{ key }` for the frontend.

### Frontend
- `public/sw.js` service worker: on `push`, parse the JSON and
  `showNotification(title, { body, image, data:{ click } })`; on
  `notificationclick`, focus/open `click`.
- Notifications page: an **"Enable push on this browser"** button →
  `navigator.serviceWorker.register('/sw.js')` → `pushManager.subscribe({
  userVisibleOnly:true, applicationServerKey })` → POST the subscription to
  `POST /notifications` as `{ type:'webpush', name:'This browser', config:{...} }`.
  A subscribed browser shows as a `webpush` channel row (test/enable/delete like
  the others; the config fields are hidden — it's not hand-edited).

### Send
- `send` branches by type: `webpush` → the `web-push` library
  `sendNotification(subscription, JSON.stringify(payload), { vapidDetails })`;
  everything else stays the generic `fetch`. On `404`/`410` from the push
  service → delete the channel (subscription expired) and treat as a
  non-retryable failure (no delivery row).

## Feature 3 — Pushover

One driver: POST `https://api.pushover.net/1/messages.json` with
`{ token, user, title, message, priority, url }`; severity→priority
(low=-1, medium=0, high=1); image as a multipart `attachment`. Validation in
`validateChannel`: `pushover` config needs `token` + `user`. Renders a
`{ title, message, priority, url }` shape.

## Feature 4 — durable retry (failures-only)

- On any send failure in dispatch (except a web-push 410 delete), insert a
  `notification_deliveries` row: `attempts=1, nextAttemptAt=now+30s,
  status='pending', payload=<render inputs>, lastError=<msg>`.
- **Sweeper:** a `setInterval` (~15s) started once on backend boot. Each tick:
  claim up to N `pending` rows where `nextAttemptAt <= now` (guarded status
  update so a tick can't double-send), rebuild the request from `payload`,
  re-send. Success → `status='sent'`. Failure → `attempts++`,
  `nextAttemptAt = now + backoff[min(attempts-1, len-1)]` with
  `backoff=[30s,2m,10m,1h,6h]`; when `attempts >= 5` → `status='dead'`.
- Single node: no distributed lock; the guarded update (`... WHERE id=? AND
  status='pending'`) is enough for one process.

## Backward compatibility

Additive. `alerts.snapshotPath` is nullable (old alerts have none → text-only,
unchanged). The two new `type`s extend an enum-by-validation, no existing type
changes. M3a's inline happy path is untouched; the retry queue only engages on
failure. Web push is inert until VAPID env is set. A deployment that configures
none of the new features behaves exactly like M3a.

## Testing

- **Pure/unit (host):** snapshot token sign+verify (valid / tampered / expired);
  backoff schedule (`attempts → delay`, caps at the last, `dead` at 5); pushover
  `buildRequest` (url/fields/priority); `renderAlert` snapshot wiring per type;
  `validateChannel` for `pushover` (needs token+user) and `webpush`.
- **DB (test-Postgres):** a failed send inserts one `pending` delivery; a sweeper
  tick on a due row transitions `pending→sent` on success and
  `pending→(attempts++ , nextAttemptAt bumped)` on failure, reaching `dead` at 5;
  a not-yet-due row is skipped.
- **Web push:** unit the payload shaping + the `410 → channel deleted, no
  delivery row` branch with a mocked library send (no real push service in CI).
- **Frontend:** `npm run build`; the service worker registers.
- **Live e2e (docker):** real detection → `alerts.snapshotPath` set → the
  snapshot arrives inline on ntfy + Telegram and webhook's `snapshotUrl`
  resolves to the JPEG; a browser subscribe → a push notification arrives with
  the tab closed, showing the image; a channel pointed at a dead endpoint yields
  a `notification_deliveries` row that retries and lands `dead`; the M3a
  guarantee still holds (a failing channel never breaks alert persistence).

## Rollout / definition of done

`docker compose up`, set VAPID env → open Notifications, click **Enable push on
this browser**, walk in front of the camera → a native browser notification
appears (tab closed) with the detection image and a tap-through to the footage.
The same detection delivers the image inline to a configured ntfy topic and
Telegram chat, and a `snapshotUrl` in the webhook JSON. A Pushover channel
receives the image + text. Killing a channel's endpoint mid-run produces a
delivery row that the sweeper retries on the backoff schedule and marks `dead`
after 5 attempts — with alert persistence and the other channels unaffected.
