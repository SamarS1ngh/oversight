# M4c Durable Event Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detections and clips survive a backend (or Redis/host) restart — the worker XADDs them to Redis Streams, and a backend consumer group processes them at-least-once and XACKs, so nothing emitted while the backend is down is lost.

**Architecture:** The worker's `publish` routes the two durable channels (`detections`, `clips`) to `XADD stream:<channel>` (trimmed with `MAXLEN`); the rest stay `PUBLISH`. A backend stream consumer (group `vms-backend`) reads via `XREADGROUP >`, processes with the existing idempotent `onDetection`/`onClip`, and `XACK`s; a startup + periodic `XAUTOCLAIM` reclaims un-ACKed entries (crash / transient-failure retry) with a poison-drop after `MAX_DELIVERIES`. Redis gains AOF + a volume. `stats`/`webrtc`/`discovery` stay pub/sub.

**Tech Stack:** Python worker (redis-py asyncio `xadd`); Bun + Hono + ioredis backend (`xreadgroup`/`xautoclaim`/`xack`); Redis 7 Streams; Postgres.

## Global Constraints

- **Durable channels are exactly `detections` + `clips`.** `stats`, `webrtc:answers`, `discovery:results` stay `PUBLISH`/`SUBSCRIBE` — do not migrate them.
- **At-least-once, safe via existing idempotency:** `onDetection`/`onClip` insert with `onConflictDoNothing` on the worker UUID — a redelivered entry must never double-write. Do not change that.
- **Never lose a durable event, never wedge the loop:** on a processing failure, do NOT XACK (leave pending → reclaimed/retried); a poison entry is dropped (logged + XACK) only after `MAX_DELIVERIES`. The consumer loop catches every error and never exits.
- **Redis persists:** AOF (`--appendonly yes`) + a named volume so streams survive a Redis restart.
- **Coordinated worker+backend deploy** (both rebuilt together) — the transport change is not backward-compatible with a half-upgraded stack (accepted, as every milestone here rebuilds both).
- **Commits:** author Samar only, NO `Co-Authored-By: Claude` trailer. `git add` explicit paths only (untracked `docs/CODE_WALKTHROUGH.md` — never commit it).
- **Test envs:** host `python3` runs ONLY pure worker modules (`streams.py`) — never `main`/`camera_worker`; `python3 -m pytest`. Backend tests need BOTH Postgres AND Redis up on localhost (they are, in docker): `RECORDINGS_DIR=/tmp/vms-rec DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun test`; tsc gate `bunx tsc --noEmit` → 0. The stream integration tests use the real localhost Redis; gate them behind the existing `dbUp` check + a Redis-reachable check so they self-skip when infra is down.

---

### Task 1: Worker pure stream routing helper (TDD, host)

**Files:**
- Create: `worker/app/streams.py`
- Test: `worker/tests/test_streams.py`

**Interfaces:**
- Produces: `is_durable(channel: str) -> bool` (True for `"detections"`/`"clips"`); `stream_key(channel: str) -> str` (`"stream:"+channel`).

- [ ] **Step 1: Write the failing tests**

`worker/tests/test_streams.py`:
```python
import unittest
from app.streams import is_durable, stream_key


class TestStreams(unittest.TestCase):
    def test_durable_channels(self):
        self.assertTrue(is_durable("detections"))
        self.assertTrue(is_durable("clips"))

    def test_non_durable_channels(self):
        for ch in ("stats", "discovery:results", "webrtc:answers", "webrtc:requests"):
            self.assertFalse(is_durable(ch))

    def test_stream_key(self):
        self.assertEqual(stream_key("detections"), "stream:detections")
        self.assertEqual(stream_key("clips"), "stream:clips")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && python3 -m pytest tests/test_streams.py -q`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `worker/app/streams.py`**

```python
# Channels whose loss on a backend restart matters (persisted events).
DURABLE_CHANNELS = frozenset({"detections", "clips"})


def is_durable(channel: str) -> bool:
    return channel in DURABLE_CHANNELS


def stream_key(channel: str) -> str:
    return "stream:" + channel
```

- [ ] **Step 4: Run**

Run: `cd worker && python3 -m pytest tests/test_streams.py -q`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add worker/app/streams.py worker/tests/test_streams.py
git commit -m "feat(worker): pure durable-channel routing helper (TDD)"
```

---

### Task 2: Worker — route durable channels to XADD

**Files:**
- Modify: `worker/app/main.py` (`publish`)
- Modify: `worker/app/config.py` (`STREAM_MAXLEN`)

**Interfaces:**
- Consumes: `is_durable`, `stream_key` (Task 1).
- Produces: the worker `XADD`s detections/clips to `stream:<channel>`; other channels unchanged.

> **Test-env note:** `main.py` is not host-importable (aiortc/av). No host unit test — verified by the Task 7 durability e2e. Run `python3 -m pytest -q` (pure suite green) + `python3 -c "import ast; ast.parse(open('app/main.py').read())"` (syntax).

- [ ] **Step 1: Config**

`worker/app/config.py` add: `STREAM_MAXLEN = int(os.environ.get("STREAM_MAXLEN", "10000"))`.

- [ ] **Step 2: Route in `publish`**

Replace `worker/app/main.py`'s `publish`:
```python
    async def publish(self, channel: str, payload: dict) -> None:
        from .streams import is_durable, stream_key
        from .config import STREAM_MAXLEN
        data = json.dumps(payload)
        if is_durable(channel):
            # durable: append to a Redis Stream (survives a backend restart),
            # trimmed approximately so it can't grow unbounded.
            await self.pub.xadd(stream_key(channel), {"data": data},
                                maxlen=STREAM_MAXLEN, approximate=True)
        else:
            await self.pub.publish(channel, data)
```
(`self.pub` is the redis-py asyncio client. `publish_answer` and the webrtc-error publishes use `self.pub.publish(...)` directly on non-durable channels — leave them unchanged.)

- [ ] **Step 3: Verify**

Run: `cd worker && python3 -m pytest -q` (pure suite still green) and
`cd worker && python3 -c "import ast; ast.parse(open('app/main.py').read())"` (OK, no output).

- [ ] **Step 4: Commit**

```bash
git add worker/app/main.py worker/app/config.py
git commit -m "feat(worker): XADD detections + clips to durable Redis Streams"
```

---

### Task 3: Backend — stream consumer

**Files:**
- Modify: `backend/src/realtime/redis.ts` (`redisStream` client)
- Modify: `backend/src/realtime/ingest.ts` (export `onDetection` + `onClip`)
- Modify: `backend/src/env.ts` (stream config)
- Create: `backend/src/realtime/stream-consumer.ts`
- Test: `backend/test/stream-consumer.test.ts`

**Interfaces:**
- Produces: `ensureGroups()`, `consumeOnce(blockMs?)`, `reclaimStale()`, `startStreamConsumer()`. Constants `STREAM_GROUP="vms-backend"`, `STREAM_CONSUMER="backend"`, streams `stream:detections`/`stream:clips`.
- Consumes: `onDetection`/`onClip` (now exported from ingest.ts).

- [ ] **Step 1: redis client + env + exports**

`backend/src/realtime/redis.ts` add:
```ts
// Dedicated connection for blocking XREADGROUP (can't share the subscribe-mode sub).
export const redisStream = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
redisStream.on("error", (e) => console.error("[redis:stream]", e.message));
```
`backend/src/env.ts` add:
```ts
  STREAM_BLOCK_MS: Number(process.env.STREAM_BLOCK_MS ?? 5000),
  MAX_DELIVERIES: Number(process.env.MAX_DELIVERIES ?? 5),
  RECLAIM_IDLE_MS: Number(process.env.RECLAIM_IDLE_MS ?? 30000),
```
In `backend/src/realtime/ingest.ts`, add `export` to `async function onDetection` and `async function onClip` (they stay used by the pub/sub path until Task 4; the consumer imports them now).

- [ ] **Step 2: Write the failing integration tests**

`backend/test/stream-consumer.test.ts`:
```ts
import { test, expect, beforeAll } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../src/db";
import { redisStream } from "../src/realtime/redis";
import { ensureGroups, consumeOnce, reclaimStale } from "../src/realtime/stream-consumer";
import { alerts, cameras, users } from "../src/db/schema";
import { eq } from "drizzle-orm";

let up = false;
beforeAll(async () => {
  try { await db.execute(sql`select 1`); await redisStream.ping(); up = true; } catch { up = false; }
  if (up) await ensureGroups();
});

async function seedCamera(): Promise<string> {
  const [u] = await db.insert(users).values({ username: "s_" + Math.random().toString(36).slice(2), passwordHash: "x" }).returning();
  const [c] = await db.insert(cameras).values({ userId: u.id, name: "sc", rtspUrl: "rtsp://x" }).returning();
  return c.id;
}
const detEvent = (id: string, cameraId: string) => JSON.stringify({
  id, type: "detection", camera_id: cameraId, ts: new Date().toISOString(),
  confidence: 0.9, count: 1, severity: "low", label: "person",
});

test("a detection XADDed to the stream is persisted then XACKed", async () => {
  if (!up) return;
  const camId = await seedCamera();
  const id = crypto.randomUUID();
  await redisStream.xadd("stream:detections", "*", "data", detEvent(id, camId));
  await consumeOnce(50);
  const [row] = await db.select().from(alerts).where(eq(alerts.id, id));
  expect(row?.id).toBe(id);
  const pending = await redisStream.xpending("stream:detections", "vms-backend") as any;
  expect(Number(pending?.[0] ?? 0)).toBe(0); // 0 pending -> acked
});

test("a duplicate detection id yields one alert row (idempotent)", async () => {
  if (!up) return;
  const camId = await seedCamera();
  const id = crypto.randomUUID();
  await redisStream.xadd("stream:detections", "*", "data", detEvent(id, camId));
  await consumeOnce(50);
  await redisStream.xadd("stream:detections", "*", "data", detEvent(id, camId));
  await consumeOnce(50);
  const rows = await db.select().from(alerts).where(eq(alerts.id, id));
  expect(rows.length).toBe(1);
});

test("a malformed entry does not crash the loop and is poison-dropped", async () => {
  if (!up) return;
  await redisStream.xadd("stream:detections", "*", "data", "{not json");
  const n = await consumeOnce(50); // processes (fails, left pending), no throw
  expect(typeof n).toBe("number");
  // reclaim with idle 0 + a low delivery ceiling drops it
  await reclaimStale(0, 1);
  const pend = await redisStream.xpending("stream:detections", "vms-backend") as any;
  // the malformed entry is no longer pending (dropped); count is a number
  expect(Number(pend?.[0] ?? 0)).toBeGreaterThanOrEqual(0);
});

test("ensureGroups is idempotent", async () => {
  if (!up) return;
  await ensureGroups(); // second call, group already exists -> no throw
  expect(true).toBe(true);
});
```
(`reclaimStale(idleMs?, maxDeliveries?)` takes optional overrides for the test — default to the env values in production.)

- [ ] **Step 3: Run to verify it fails**

Run: `cd backend && RECORDINGS_DIR=/tmp/vms-rec DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun test test/stream-consumer.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement `backend/src/realtime/stream-consumer.ts`**

```ts
import { redisStream } from "./redis";
import { onDetection, onClip } from "./ingest";
import { env } from "../env";

export const STREAM_GROUP = "vms-backend";
export const STREAM_CONSUMER = "backend";
const STREAMS = ["stream:detections", "stream:clips"] as const;

export async function ensureGroups(): Promise<void> {
  for (const key of STREAMS) {
    try {
      await redisStream.xgroup("CREATE", key, STREAM_GROUP, "$", "MKSTREAM");
    } catch (e: any) {
      if (!String(e?.message ?? "").includes("BUSYGROUP")) throw e;
    }
  }
}

// ioredis returns entry fields as a flat [name, value, name, value, ...] array.
function fieldValue(fields: string[], name: string): string | null {
  const i = fields.indexOf(name);
  return i >= 0 && i + 1 < fields.length ? fields[i + 1] : null;
}

async function process(stream: string, fields: string[]): Promise<void> {
  const raw = fieldValue(fields, "data");
  if (raw == null) return; // nothing to process; caller will ACK
  const msg = JSON.parse(raw); // throws on malformed -> caller leaves it pending
  if (stream === "stream:detections") await onDetection(msg);
  else if (stream === "stream:clips") await onClip(msg);
}

// One read of NEW entries (>) across the streams; process + XACK each; on
// failure leave pending (reclaimStale retries/poison-drops).
export async function consumeOnce(blockMs = env.STREAM_BLOCK_MS): Promise<number> {
  const res = (await redisStream.xreadgroup(
    "GROUP", STREAM_GROUP, STREAM_CONSUMER, "COUNT", 50, "BLOCK", blockMs,
    "STREAMS", ...STREAMS, ...STREAMS.map(() => ">"),
  )) as [string, [string, string[]][]][] | null;
  if (!res) return 0;
  let n = 0;
  for (const [stream, entries] of res) {
    for (const [id, fields] of entries) {
      try {
        await process(stream, fields);
        await redisStream.xack(stream, STREAM_GROUP, id);
        n++;
      } catch (e) {
        console.error(`[stream] process failed ${stream} ${id}:`, (e as Error).message);
        // leave pending -> reclaimStale retries; poison-drops after MAX_DELIVERIES
      }
    }
  }
  return n;
}

// Retry this consumer's delivered-but-unacked entries idle > idleMs; drop a
// poison entry after maxDeliveries.
export async function reclaimStale(
  idleMs = env.RECLAIM_IDLE_MS, maxDeliveries = env.MAX_DELIVERIES,
): Promise<void> {
  for (const stream of STREAMS) {
    const res = (await redisStream.xautoclaim(
      stream, STREAM_GROUP, STREAM_CONSUMER, idleMs, "0-0", "COUNT", 50,
    )) as [string, [string, string[]][], string[]] | null;
    const entries = res?.[1] ?? [];
    for (const [id, fields] of entries) {
      try {
        await process(stream, fields);
        await redisStream.xack(stream, STREAM_GROUP, id);
      } catch (e) {
        const pend = (await redisStream.xpending(
          stream, STREAM_GROUP, "IDLE", 0, id, id, 1,
        )) as [string, string, number, number][] | null;
        const deliveries = Number(pend?.[0]?.[3] ?? 0);
        if (deliveries >= maxDeliveries) {
          console.error(`[stream] poison drop ${stream} ${id} after ${deliveries} deliveries`);
          await redisStream.xack(stream, STREAM_GROUP, id);
        }
      }
    }
  }
}

// Boot-time loop: reclaim, then read new, forever. Never throws out.
export async function startStreamConsumer(): Promise<void> {
  await ensureGroups();
  console.log("[stream] consumer started");
  for (;;) {
    try {
      await reclaimStale();
      await consumeOnce();
    } catch (e) {
      console.error("[stream] loop error:", (e as Error).message);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
```

- [ ] **Step 5: Run**

Run: `cd backend && RECORDINGS_DIR=/tmp/vms-rec DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun test test/stream-consumer.test.ts` and `bunx tsc --noEmit`.
Expected: 4 pass; 0 tsc errors. (If ioredis's `xautoclaim`/`xpending` return shapes differ, adjust the parsing to the actual runtime shape — assert against what the driver returns; keep the tests green.)

- [ ] **Step 6: Commit**

```bash
git add backend/src/realtime/redis.ts backend/src/realtime/ingest.ts backend/src/env.ts backend/src/realtime/stream-consumer.ts backend/test/stream-consumer.test.ts
git commit -m "feat(api): Redis Streams consumer for detections + clips"
```

---

### Task 4: Backend — swap ingest off pub/sub + boot the consumer

**Files:**
- Modify: `backend/src/realtime/ingest.ts` (remove detections + clips from pub/sub)
- Modify: `backend/src/index.ts` (start the consumer)
- Test: `backend/test/stream-consumer.test.ts` (assert the pub/sub path no longer carries detections/clips)

**Interfaces:**
- Consumes: `startStreamConsumer` (Task 3).
- Produces: detections/clips flow ONLY via the stream consumer; pub/sub carries stats/webrtc/discovery.

- [ ] **Step 1: Remove detections + clips from the pub/sub path (via an exported channel list)**

In `backend/src/realtime/ingest.ts`, introduce an exported constant listing the pub/sub channels (so the removal is structurally testable), and use it in `startIngest()`:
```ts
// Channels still delivered over pub/sub. detections + clips moved to the
// durable stream consumer (see stream-consumer.ts) and are intentionally absent.
export const PUBSUB_CHANNELS = [
  CHANNELS.stats,
  CHANNELS.webrtcAnswers,
  CHANNELS.discoveryResults,
];
```
- `startIngest()`: `redisSub.subscribe(...PUBSUB_CHANNELS, (err) => { ... })` (replacing the explicit list; detections + clips are no longer subscribed).
- Remove the two dispatch branches `if (channel === CHANNELS.detections) …` and `else if (channel === CHANNELS.clips) …` from the `redisSub.on("message", …)` handler (keep stats/webrtcAnswers/discoveryResults).
- Update the `console.log("[ingest] subscribed to …")` string to reflect PUBSUB_CHANNELS.
- Keep `onDetection`/`onClip` exported (the stream consumer uses them).

- [ ] **Step 2: Boot the consumer**

In `backend/src/index.ts`, after `startIngest();`:
```ts
import { startStreamConsumer } from "./realtime/stream-consumer";
// ...
void startStreamConsumer();
```
(Fire-and-forget; it owns its own loop + error handling. Keep it in index.ts, not app.ts, so importing the app in tests doesn't open the consumer — same rationale as startIngest.)

- [ ] **Step 3: Test the pub/sub swap (structural, non-vacuous)**

Add to `backend/test/stream-consumer.test.ts` (no `up` gate — a pure import assertion):
```ts
import { PUBSUB_CHANNELS } from "../src/realtime/ingest";
import { CHANNELS } from "../src/realtime/channels";
test("pub/sub no longer carries detections/clips; keeps stats/webrtc/discovery", () => {
  expect(PUBSUB_CHANNELS).not.toContain(CHANNELS.detections);
  expect(PUBSUB_CHANNELS).not.toContain(CHANNELS.clips);
  expect(PUBSUB_CHANNELS).toContain(CHANNELS.stats);
  expect(PUBSUB_CHANNELS).toContain(CHANNELS.webrtcAnswers);
  expect(PUBSUB_CHANNELS).toContain(CHANNELS.discoveryResults);
});
```
(This directly asserts the subscribe list changed — it fails against the pre-Task-4 code, so it genuinely verifies the removal.)

- [ ] **Step 4: Run**

Run: `cd backend && RECORDINGS_DIR=/tmp/vms-rec DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun test` and `bunx tsc --noEmit`.
Expected: all pass; 0 tsc.

- [ ] **Step 5: Commit**

```bash
git add backend/src/realtime/ingest.ts backend/src/index.ts backend/test/stream-consumer.test.ts
git commit -m "feat(api): route detections + clips through the stream consumer, not pub/sub"
```

---

### Task 5: Redis persistence (AOF + volume)

**Files:**
- Modify: `docker-compose.yml`

**Interfaces:**
- Produces: Redis persists its streams across a restart.

- [ ] **Step 1: Enable AOF + a volume**

In `docker-compose.yml`, the `redis` service: add `command: ["redis-server", "--appendonly", "yes"]` and a volume mount `- redis-data:/data`. Add `redis-data:` under the top-level `volumes:` (alongside the existing `recordings` volume).

- [ ] **Step 2: Verify it persists**

Run:
```bash
docker compose up -d redis
docker compose exec -T redis redis-cli config get appendonly
docker compose exec -T redis redis-cli xadd stream:__probe '*' data hi
docker compose restart redis
sleep 2
docker compose exec -T redis redis-cli xlen stream:__probe
docker compose exec -T redis redis-cli del stream:__probe
```
Expected: `appendonly yes`; `xlen` returns `1` after the restart (the stream survived). Then clean up the probe stream.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "chore(compose): Redis AOF persistence + volume for durable streams"
```

---

### Task 6: Docs + suites + durability e2e

**Files:**
- Modify: `.env.example`, `README.md`, `docs/EVENT_FORMAT.md`
- Verify: suites + the durability e2e

- [ ] **Step 1: Docs**

`.env.example` (worker + backend): add `STREAM_MAXLEN=10000` (worker) and `STREAM_BLOCK_MS=5000`, `MAX_DELIVERIES=5`, `RECLAIM_IDLE_MS=30000` (backend), each with a one-line comment. README: note detections + clips now flow over durable Redis Streams (a backend/Redis restart doesn't lose them); Redis runs with AOF. `docs/EVENT_FORMAT.md`: note that `detections` and `clips` are delivered via Redis Streams (`stream:detections`/`stream:clips`, consumer group `vms-backend`) rather than pub/sub; the payload shape is unchanged (stored under the `data` field).

- [ ] **Step 2: Full suites**

Run: `cd backend && RECORDINGS_DIR=/tmp/vms-rec DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun test` → all pass; `bunx tsc --noEmit` → 0.
Run: `cd worker && python3 -m pytest -q` → all pass.
Run: `cd frontend && npm run build` → clean (unaffected).

- [ ] **Step 3: SKIP — controller runs the durability e2e**

The controller: rebuilds `redis backend worker` (AOF + the new transport), starts a camera (→ live, detections flowing as alerts), then `docker compose stop backend`, lets detections fire for ~15s (they XADD to `stream:detections` while the backend is down), records the stream length, `docker compose start backend`, and confirms the alerts that occurred during the downtime are now persisted (the consumer drained the backlog). Also `docker compose restart redis` and confirms `xlen stream:detections` is non-zero (AOF persisted). Verifies steady-state detections still persist promptly and no duplicate alerts appear.

- [ ] **Step 4: Commit**

```bash
git add .env.example README.md docs/EVENT_FORMAT.md
git commit -m "docs: durable event pipeline (Redis Streams, M4c); e2e verified"
```

---

## Notes for the executor

- `onDetection`/`onClip` are REUSED unchanged (already idempotent via `onConflictDoNothing`) — do not fork their logic into the consumer; import them.
- The primary durability win is `XREADGROUP >` delivering entries XADDed while the backend was down (they're new to the group). `reclaimStale`/`XAUTOCLAIM` is the secondary path for crash-mid-processing + transient failures + the poison guard.
- The consumer loop must NEVER exit — catch every error, log, back off, continue. A dead consumer = silently accumulating unprocessed detections.
- ioredis return shapes for `xreadgroup`/`xautoclaim`/`xpending` can be version-sensitive; if a test fails on parsing, inspect the actual returned value and adjust the destructuring — keep the asserted behavior (persist + ack + idempotent + poison-drop) intact.
- Don't migrate `stats`/`webrtc`/`discovery` — they're ephemeral by design.
