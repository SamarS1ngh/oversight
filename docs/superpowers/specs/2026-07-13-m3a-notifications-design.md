# M3a — Notification Engine + webhook / ntfy / Telegram

**Date:** 2026-07-13
**Milestone:** M3a of the [OSS VMS roadmap](./2026-07-04-oss-vms-product-roadmap.md)
**Goal:** Deliver alerts off the browser. When an alert is persisted, dispatch it to
the owner's configured notification channels — **webhook**, **ntfy**, **Telegram** —
so a security event reaches a phone/Slack/automation instantly, even with no tab open.

## Scope

**In:** a `notification_channels` table + owner-scoped CRUD + a per-channel test
endpoint; a notifier that, on each persisted alert, filters the owner's channels
(min-severity + camera set), renders a per-channel message, and dispatches via a
driver; three drivers (webhook, ntfy, Telegram); per-(channel,camera) cooldown to
stop spam; a config UI. Notifications are **text + a tap-through link** (no inline
image in this milestone).

**Out (this milestone → M3b):** email (SMTP), web push (VAPID + service worker),
Pushover. Inline snapshot images in the push. Durable retry queue.

## Decisions locked (from brainstorming)

- **Channels:** webhook, ntfy, Telegram (dead-simple HTTP POSTs, zero infra).
- **Fire on the alert** (in `ingest.ts onDetection`), immediately — text + a link
  that opens the footage once the clip lands. Every alert notifies (presence,
  tripwire, dwell — all land in `onDetection`). No worker changes.
- **Cooldown per (channel, camera)**, default 60s, in-memory (best-effort; resets
  on API restart). `cooldownSecs = 0` disables it.
- **Link → `${APP_URL}/events?camera=<id>`** (Events page filtered). `APP_URL` env,
  default `http://localhost:3000`.
- **Channel config (incl. tokens) stored in DB** and returned to the owning user's
  UI for editing — acceptable for a single-user self-hosted deployment.
- **ntfy severity→priority:** low=2, medium=3, high=5.
- **Best-effort dispatch:** fire-and-forget; a failing channel logs and never
  blocks ingest or the other channels. No durable retry (M4 territory).

## Architecture

Entirely **API-side**. `ingest.ts onDetection` already: inserts the alert row →
`ownerOf(cameraId)` → `sendToUser` (WS fanout). We add one call after that:
`void dispatchNotifications(alert, ownerId)` — fire-and-forget so it never blocks
or fails ingest. It loads the owner's enabled channels, filters, renders, and
sends. Drivers sit behind a small interface; each is one `fetch()`.

```
ingest.onDetection(alert)
  insert alert -> WS fanout (existing)
  void dispatchNotifications(alert, ownerId)      # new, non-blocking
      channels = load enabled notification_channels for ownerId
      for ch in channels:
        if not shouldNotify(ch, alert): continue                  # severity + camera filter
        if not cooldown.allow(ch.id+":"+alert.cameraId, now, ch.cooldownSecs): continue
        payload = renderAlert(type, alert, camera, ruleName, link)
        req = buildRequest(ch.type, ch.config, payload)           # pure
        try: await send(req)  except: log                         # best-effort
```

## Data model — new `notification_channels`

```
id            uuid pk default random
userId        uuid -> users.id (cascade delete)
type          text not null            -- 'webhook' | 'ntfy' | 'telegram'
name          text not null
config        jsonb not null           -- see per-type below
minSeverity   text not null default 'low'   -- low|medium|high; fire when alert sev >= this
cameraIds     jsonb                    -- string[] | null (null = all the user's cameras)
cooldownSecs  integer not null default 60
enabled       boolean not null default true
createdAt     timestamptz default now
index (userId)
```
Per-type `config`: webhook `{ url }`; ntfy `{ topic, server?, token? }` (server
default `https://ntfy.sh`); telegram `{ botToken, chatId }`.

## Backend

### `backend/src/notify/render.ts` (pure, tested)
`sevRank(s)` = low0/med1/high2. `renderAlert(type, alert, cameraName, ruleName, link)`:
- **webhook** → `{ event: "alert", alert: {id,severity,label,ruleId,cameraId,ts,count,confidence}, camera: {id,name}, rule: {name}|null, url: link }`.
- **ntfy** → `{ title: "<CameraName>: <severity> <label>", body: "<ruleName or 'detection'> · <count>", priority: sev→{low:2,medium:3,high:5}, tags: [sev], click: link }`.
- **telegram** → `{ text: "*<severity>* <label> on *<CameraName>*\n<ruleName> · <count> · <time>\n<link>", parse_mode: "Markdown" }`.

### `backend/src/notify/filter.ts` (pure, tested)
`shouldNotify(channel, alert): boolean` = `sevRank(alert.severity) >= sevRank(channel.minSeverity)` AND (`channel.cameraIds == null` OR `channel.cameraIds.includes(alert.cameraId)`).

### `backend/src/notify/cooldown.ts` (pure, tested)
Module-level `Map<string, number>`; `allow(key, nowMs, cooldownSecs): boolean` — true (and records `now`) if `cooldownSecs <= 0` or `now - last >= cooldownSecs*1000`; false otherwise. `key = channelId + ":" + cameraId`.

### `backend/src/notify/drivers.ts` (buildRequest pure/tested; send thin)
`buildRequest(type, config, payload): { url, method, headers, body }`:
- webhook → `POST config.url`, `content-type: application/json`, body = JSON(payload).
- ntfy → `POST (config.server ?? "https://ntfy.sh") + "/" + config.topic`, headers `Title/Priority/Tags/Click` (+ `Authorization: Bearer <token>` if `config.token`), body = payload.body (text).
- telegram → `POST https://api.telegram.org/bot<botToken>/sendMessage`, `content-type: application/json`, body = JSON({ chat_id: config.chatId, ...payload }).
`send(req): Promise<{ ok, status }>` — `fetch(req.url, {method,headers,body})`; returns `ok` + status (thin, not unit-tested; e2e).

### `backend/src/notify/dispatch.ts`
`dispatchNotifications(alert, ownerId)`: load `enabled` channels for `ownerId`;
look up the camera name (owner-scoped) and the rule name (if `alert.ruleId`); build
`link = APP_URL + "/events?camera=" + alert.cameraId`; for each channel that passes
`shouldNotify` + `cooldown.allow`, `render` → `buildRequest` → `send`, each wrapped
in `try/catch` with `console.error` on failure. No import-time side effects.

### `backend/src/notify/routes.ts` (owner-scoped, mounted `/notifications`)
- `GET /notifications` — the caller's channels.
- `POST /notifications` — validate `type`, `minSeverity` enum, per-type required
  config (webhook.url, ntfy.topic, telegram.botToken+chatId), `cooldownSecs >= 0`,
  `cameraIds` (null or string[]).
- `PATCH /notifications/:id` / `DELETE /notifications/:id` — owner-scoped, uuid-guarded.
- `POST /notifications/:id/test` — render+send a synthetic alert (severity high,
  label "test", the channel's first camera or a placeholder) and return `{ ok, status }`
  or `{ ok:false, error }` so the UI shows delivered/failed.

### Wiring
`ingest.ts onDetection`: after `sendToUser(owner, {channel:"alert", data:d})`, add
`if (owner) void dispatchNotifications(d, owner);`. `app.ts` mounts `notifyRoutes`.
`env.ts` gains `APP_URL`.

## Frontend

- `lib/types.ts`: `NotifChannelType = "webhook"|"ntfy"|"telegram"`; `NotifChannel`
  `{ id, type, name, config, minSeverity, cameraIds, cooldownSecs, enabled, createdAt }`.
- `lib/api.ts`: `listChannels`, `createChannel`, `updateChannel`, `deleteChannel`,
  `testChannel(id)`.
- `app/notifications/page.tsx` (+ a "Notifications" topbar link on the dashboard):
  channel list (type, name, severity, enable/disable, delete, **Test** button that
  shows delivered/failed); add/edit form — type selector switching the config fields
  (webhook: url; ntfy: topic + server + token; telegram: botToken + chatId), a
  min-severity select, a camera multiselect (or "all"), a cooldown-seconds input,
  enabled toggle. Auth redirect like the other pages.

## Backward compatibility

Purely additive. No existing table/route/behavior changes except the one
non-blocking `dispatchNotifications` call in `onDetection` (guarded by `owner`,
wrapped so a failure can't affect alert persistence or WS fanout). A user with no
channels gets no notifications (unchanged behavior).

## Testing

- **Backend pure:** `filter` (severity ranks + camera-set matrix, `cameraIds=null`
  = all), `cooldown` (first allow, suppressed within window, allowed after, `0` =
  always), `render` (each type's payload shape + severity mapping), `buildRequest`
  (url/headers/body per type, ntfy auth header present only with a token).
- **Backend DB:** channels CRUD + ownership (another user can't read/patch/delete/
  test my channel → 404); validation (bad type / missing per-type config / bad
  severity → 400).
- **Frontend:** `npm run build`.

## Rollout / definition of done

`docker compose up` → add an **ntfy** channel (a topic) via the UI, hit **Test** →
the phone/ntfy topic receives it. Add a **webhook** to a request-bin/local server →
a real person detection POSTs the alert JSON with the link. Add a **Telegram**
channel (bot token + chat id) → detections arrive in the chat. A second channel with
`minSeverity=high` only fires on high-severity (tripwire) alerts; the cooldown
collapses a burst on one camera to one notification per window. Notifications never
delay or break alert persistence.
