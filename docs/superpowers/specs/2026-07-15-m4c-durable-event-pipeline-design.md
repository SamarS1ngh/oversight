# M4c — Durable Event Pipeline

**Date:** 2026-07-15
**Milestone:** M4c of the [OSS VMS roadmap](./2026-07-04-oss-vms-product-roadmap.md)
**Goal:** Stop losing detections and clips when the backend is down. Today the
worker `PUBLISH`es events over Redis pub/sub — fire-and-forget, so anything
emitted while the backend's subscriber is offline (a restart, a deploy) is
dropped: a missed alert, a missed notification, an orphaned recording. M4c moves
the two persisted-event channels to **Redis Streams with a consumer group**, so
events wait durably in Redis and are delivered when the backend comes back.

## Scope

**In:** the worker `XADD`s detections + clips to Redis Streams (with `MAXLEN`
trimming); a backend stream consumer (consumer group, `XREADGROUP`, process →
`XACK`, pending-reprocess on startup, a poison-message guard); Redis AOF
persistence + a volume in compose so streams survive a Redis/host restart; the
existing `onDetection`/`onClip` processing reused unchanged (already idempotent).

**Out:** making `stats`/`state`, `webrtc`, or `discovery:results` durable — they
are ephemeral (the next heartbeat / a retry re-syncs); a multi-consumer /
horizontally-scaled backend (single-consumer group, single self-hosted node); a
dead-letter *queue* (poison messages are logged + ACKed, not re-queued).

## Decisions locked (from brainstorming)

- **Redis Streams + consumer group** (not a worker-side outbox or a Postgres
  outbox). Redis stays the broker; the change is `PUBLISH`→`XADD` +
  `SUBSCRIBE`→consumer-group `XREADGROUP` for the two durable channels.
- **Durable channels: detections + clips.** `stats`/`webrtc`/`discovery` stay
  pub/sub.
- **Redis persists (AOF + named volume)** so streams survive a Redis/host
  restart, not just a backend restart.
- **At-least-once, made safe by existing idempotency:** `onDetection` and
  `onClip` insert with `onConflictDoNothing` on the worker's UUID, so a
  redelivered entry never double-writes.
- **Poison guard:** an entry whose processing keeps throwing is retried up to
  `MAX_DELIVERIES`, then logged and `XACK`ed (dropped) so it can't wedge the
  loop. No separate DLQ table.

## Architecture

```
worker: detection / clip_ready
   → XADD stream:detections / stream:clips  (MAXLEN ~ STREAM_MAXLEN, approx trim)
     (lands in Redis whether or not the backend is up)
   stats / camera_state / webrtc:* / discovery:results → PUBLISH (unchanged)

backend stream consumer (group "vms-backend", consumer "backend"):
   startup: XGROUP CREATE stream:detections/stream:clips vms-backend $ MKSTREAM
            (ignore BUSYGROUP); then reprocess this consumer's PENDING first
   loop: XREADGROUP GROUP vms-backend backend COUNT n BLOCK STREAM_BLOCK_MS
         STREAMS stream:detections stream:clips >
         for each entry: onDetection / onClip → XACK on success
         on exception: no XACK (redelivered); if deliveries >= MAX_DELIVERIES
                       → log + XACK (drop poison)

backend ingest (pub/sub): SUBSCRIBE stats, webrtc:answers, discovery:results
   (detections + clips REMOVED from the pub/sub path — now via the stream consumer)
```

## Worker (`worker/app/main.py`)

`publish(channel, payload)` gains routing: durable channels go to
`XADD stream:<channel>` with `maxlen=STREAM_MAXLEN, approximate=True`; all other
channels keep `PUBLISH`. Callers (`camera_worker._emit`, clip emit) are
unchanged — the routing is centralized in the one method.

- `is_durable(channel) -> bool` — a pure, host-testable helper: `True` for
  `"detections"` and `"clips"`, else `False`.
- Stream key = `"stream:" + channel`. Payload stored under a single field, e.g.
  `{"data": json.dumps(payload)}` (the backend reads `fields["data"]`).
- Config (`config.py`): `STREAM_MAXLEN` (default 10000).

## Backend

### `backend/src/realtime/redis.ts`
Add a third client `redisStream` (ioredis) — a blocking `XREADGROUP` needs its
own connection, separate from the pub/sub `redisSub` (subscribe mode) and
`redisPub`.

### `backend/src/realtime/stream-consumer.ts` (new)
- `ensureGroups()` — `XGROUP CREATE <stream> vms-backend $ MKSTREAM` for each
  durable stream, swallowing `BUSYGROUP` (already exists).
- `processEntry(stream, id, fields)` — parse `fields.data`, route to the existing
  `onDetection` (stream:detections) / `onClip` (stream:clips), return
  success/failure.
- `reclaimStale()` — `XAUTOCLAIM <stream> vms-backend backend <MIN_IDLE_MS> 0`
  claims this group's ("vms-backend") delivered-but-unacked entries idle longer than
  `RECLAIM_IDLE_MS` and returns each with its delivery count → process → XACK on
  success; on failure leave pending (a later `reclaimStale` retries it); once the
  delivery count reaches `MAX_DELIVERIES`, log + XACK (drop the poison message so
  it can't wedge the loop). This is what makes "no XACK on failure → redelivered"
  actually true — a plain `XREADGROUP >` only ever returns *new* entries, so
  reclaim is the retry path for both a transient failure and a crash between
  delivery and ACK.
- `startStreamConsumer()` — `ensureGroups()`, then loop: first `reclaimStale()`
  (drains/retries this consumer's pending, incl. entries left by a prior crash),
  then `XREADGROUP GROUP vms-backend backend BLOCK STREAM_BLOCK_MS STREAMS
  stream:detections stream:clips >` for new entries → process → XACK on success
  (skip on failure — reclaim will retry). The loop is resilient: any Redis error
  is caught, logged, and retried after a short delay; it never exits.
  Config: `RECLAIM_IDLE_MS` (~30000).
- Config (`env.ts`): `STREAM_BLOCK_MS` (5000), `MAX_DELIVERIES` (5); constants
  `STREAM_GROUP = "vms-backend"`, `STREAM_CONSUMER = "backend"`, the two stream
  keys.

### `backend/src/realtime/ingest.ts`
- Remove `CHANNELS.detections` and `CHANNELS.clips` from the `redisSub.subscribe`
  list and the `on("message")` dispatch (they arrive via the stream consumer
  now). Keep `stats`, `webrtcAnswers`, `discoveryResults`.
- `startIngest()` additionally calls `startStreamConsumer()` (fire-and-forget;
  the consumer owns its own loop + error handling).
- `onDetection`/`onClip` are exported/reused by the stream consumer unchanged.

### `docker-compose.yml`
`redis` service: `command: ["redis-server", "--appendonly", "yes"]`; add
`volumes: [redis-data:/data]` and a top-level `redis-data:` volume.

## Backward compatibility

The worker→backend contract for detections/clips changes transport (pub/sub →
stream) but not payload shape; `onDetection`/`onClip` are unchanged and
idempotent. A mixed-version window (old worker PUBLISHing while the new backend
only reads the stream, or vice versa) would drop those events — this is a
coordinated worker+backend deploy (both rebuilt together, as in every milestone
here). `stats`/`webrtc`/`discovery` are untouched. Redis gaining AOF is additive
(a first start creates the volume + appendonly file).

## Testing

- **Worker (pure, host):** `is_durable("detections")`/`("clips")` → True;
  `("stats")`/`("discovery:results")`/`("webrtc:answers")` → False.
- **Backend (integration — real Redis + Postgres, both up in the test env):**
  - `XADD stream:detections` a synthetic detection → one consumer cycle → the
    alert row is persisted AND the stream shows 0 pending (XACKed).
  - the same entry delivered twice (duplicate id or a manual re-add) → still one
    alert row (idempotency).
  - a malformed entry (bad JSON) → does not crash the loop; ACKed after the
    poison guard; a following good entry still processes.
  - `ensureGroups()` is idempotent (second call with an existing group is a
    no-op, no throw).
- **Frontend:** unaffected (no change) — `npm run build` stays green.
- **The durability e2e (docker):** camera live → `docker compose stop backend` →
  let real detections fire for ~15s (they `XADD` to the stream while the backend
  is down) → `docker compose start backend` → the consumer drains the backlog →
  the alerts that occurred **during the downtime** are now in the DB (compare the
  alert count / ids to the detections emitted while down). Then
  `docker compose restart redis` → the stream is NOT empty (AOF persisted it).

## Rollout / definition of done

`docker compose up`. With a camera running, stop the backend, trigger some
detections, and restart the backend: every detection that happened while it was
down appears as an alert (and fires its notification / links its clip) once the
backend catches up — nothing is lost. Restarting Redis does not empty the
pending streams. Steady-state behavior is unchanged (detections/clips still flow
promptly; stats/WebRTC/discovery still use pub/sub); duplicate delivery never
produces duplicate alerts.
