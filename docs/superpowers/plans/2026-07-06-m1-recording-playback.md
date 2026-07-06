# M1 Recording & Playback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a detection fires, the worker records a short MP4 clip (with ~10s of footage from *before* the trigger) plus a thumbnail, the API stores and serves it linked to the alert, and the browser shows a play button and an Events gallery — with old clips auto-pruned.

**Architecture:** Recording lives entirely in the Python **worker** (closest to the H.264 packet stream, like dedup). It keeps a rolling deque of recent *compressed* packets and, on an emitted detection, remuxes `[pre-roll + live + post-roll]` into an MP4 by **codec-copy (no re-encode)** using PyAV, then publishes a `clip_ready` event on a new Redis `clips` channel. The **API** owns a new `clips` table, ingests `clip_ready`, serves clip video (HTTP Range) + thumbnails, and runs a periodic age+size pruner. The **frontend** gets a play button per alert (live via a new WS `clip` channel) and an Events page.

**Tech Stack:** Bun + Hono 4 + Drizzle 0.36 (Postgres), Python + PyAV (`av`) + OpenCV, Next.js 15 / React 19, Redis pub/sub.

## Global Constraints

- **Event contract is the single source of truth:** every cross-service message shape is defined in `docs/EVENT_FORMAT.md`. Add the new `clip_ready` message there; do not invent per-service shapes.
- **No import-time side effects in `backend/src/app.ts`** (no server listen, no Redis subscribe, no timers). Subscribers and the retention timer start from `backend/src/index.ts` so `app.fetch(...)` stays testable in-process.
- **Worker tests stay import-light:** unit tests must run without `torch`/`ultralytics`/`av`/`cv2` installed. Keep heavy imports local to functions; inject muxer/thumbnail/clock into the `Recorder` so its logic tests use fakes.
- **Ownership scoping everywhere:** a user may only ever read/delete clips for cameras they own (inner join on `cameras.userId`), exactly like `alerts`.
- **All ids are UUID v4 strings; all timestamps ISO-8601 UTC** (e.g. `2026-07-06T13:59:00.123Z`).
- **Idempotent inserts:** clip rows key on the worker-generated `id` with `onConflictDoNothing()`.
- **Commits:** author is Samar only. Do **not** add a `Co-Authored-By: Claude` trailer.
- **Retention defaults:** 7 days OR 10 GB, whichever hits first, evict oldest.
- **Pinned deps (do not bump):** Hono `^4.6`, drizzle-orm `^0.36`, drizzle-kit `^0.28`, Next `15`, React `19`, PyAV `av 1.9-era`. No new runtime dependencies are needed for M1.
- Commands: backend `cd backend && bun test`, migrate `cd backend && bun run db:push`; worker `cd worker && python -m unittest discover -s tests -v`; frontend `cd frontend && npm run build`.

---

### Task 1: `clips` table schema + migration

**Files:**
- Modify: `backend/src/db/schema.ts` (append after the `alerts` table)

**Interfaces:**
- Produces: `clips` Drizzle table and `Clip` type. Columns: `id` (uuid pk, worker-generated), `cameraId` (uuid, cascade), `alertId` (uuid nullable, set null on alert delete), `backend` (text default `'local'`), `path` (text), `thumbPath` (text nullable), `startTs`/`endTs` (timestamptz), `durationMs`/`sizeBytes` (integer), `createdAt` (timestamptz default now). Index `clips_camera_start_idx` on `(cameraId, startTs)`.

- [ ] **Step 1: Add the table to the schema**

Append to `backend/src/db/schema.ts` (the imports `pgTable, uuid, text, timestamp, integer, index` are already present):

```ts
// One recorded event-clip. `id` is the worker-generated UUID (idempotency key),
// matching the clip_ready event in docs/EVENT_FORMAT.md.
export const clips = pgTable(
  "clips",
  {
    id: uuid("id").primaryKey(),
    cameraId: uuid("camera_id")
      .notNull()
      .references(() => cameras.id, { onDelete: "cascade" }),
    // links to the detection/alert that triggered the clip; nullable so a clip
    // survives its alert being deleted, and so ingest can still store a clip if
    // the alert row hasn't landed yet.
    alertId: uuid("alert_id").references(() => alerts.id, {
      onDelete: "set null",
    }),
    backend: text("backend").notNull().default("local"),
    path: text("path").notNull(), // relative to RECORDINGS_DIR
    thumbPath: text("thumb_path"),
    startTs: timestamp("start_ts", { withTimezone: true }).notNull(),
    endTs: timestamp("end_ts", { withTimezone: true }).notNull(),
    durationMs: integer("duration_ms").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    cameraStartIdx: index("clips_camera_start_idx").on(t.cameraId, t.startTs),
  }),
);

export type Clip = typeof clips.$inferSelect;
```

- [ ] **Step 2: Apply the migration (requires the compose Postgres up)**

Run: `cd backend && bun run db:push`
Expected: drizzle-kit reports creating table `clips` (and the index). If no DB is reachable it errors — start `docker compose up postgres` first.

- [ ] **Step 3: Typecheck the schema**

Run: `cd backend && bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add backend/src/db/schema.ts
git commit -m "feat(db): add clips table for event recordings"
```

---

### Task 2: Retention pruner (age + size)

**Files:**
- Create: `backend/src/realtime/retention.ts`
- Create: `backend/test/retention.test.ts`
- Modify: `backend/src/env.ts` (add recording env)
- Modify: `backend/src/index.ts` (start the pruner)

**Interfaces:**
- Consumes: `clips` table (Task 1), `env` (extended here).
- Produces: `selectExpired(rows, nowMs, retentionDays): ClipRow[]`, `selectOverCap(rowsOldestFirst, maxBytes): ClipRow[]`, `runRetentionOnce(nowMs?): Promise<number>`, `startRetention(): void`, and the `ClipRow` type `{ id, path, thumbPath, sizeBytes, createdAt }`.

- [ ] **Step 1: Add env**

In `backend/src/env.ts`, add to the `env` object:

```ts
  RECORDINGS_DIR: process.env.RECORDINGS_DIR ?? "/recordings",
  RETENTION_DAYS: Number(process.env.RETENTION_DAYS ?? 7),
  MAX_STORAGE_GB: Number(process.env.MAX_STORAGE_GB ?? 10),
```

- [ ] **Step 2: Write the failing tests for the pure selectors**

Create `backend/test/retention.test.ts`:

```ts
import { test, expect } from "bun:test";
import { selectExpired, selectOverCap, type ClipRow } from "../src/realtime/retention";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
const rowAt = (id: string, tsMs: number, sizeBytes: number): ClipRow => ({
  id,
  path: `${id}.mp4`,
  thumbPath: null,
  sizeBytes,
  createdAt: new Date(tsMs),
});

test("selectExpired drops clips older than the retention window", () => {
  const rows = [rowAt("old", NOW - 8 * DAY, 10), rowAt("fresh", NOW - 1 * DAY, 10)];
  expect(selectExpired(rows, NOW, 7).map((r) => r.id)).toEqual(["old"]);
});

test("selectExpired keeps everything within the window", () => {
  const rows = [rowAt("a", NOW - 2 * DAY, 10)];
  expect(selectExpired(rows, NOW, 7)).toEqual([]);
});

test("selectOverCap drops oldest-first until total is under the cap", () => {
  const MB = 1024 * 1024;
  const rows = [rowAt("a", 1, 60 * MB), rowAt("b", 2, 60 * MB), rowAt("c", 3, 60 * MB)];
  expect(selectOverCap(rows, 120 * MB).map((r) => r.id)).toEqual(["a"]);
});

test("selectOverCap returns nothing when already under the cap", () => {
  const MB = 1024 * 1024;
  expect(selectOverCap([rowAt("a", 1, 10 * MB)], 100 * MB)).toEqual([]);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd backend && bun test test/retention.test.ts`
Expected: FAIL — cannot resolve `../src/realtime/retention`.

- [ ] **Step 4: Implement `retention.ts`**

Create `backend/src/realtime/retention.ts`:

```ts
import { asc, eq } from "drizzle-orm";
import { promises as fs } from "fs";
import { join } from "path";
import { db } from "../db";
import { clips } from "../db/schema";
import { env } from "../env";

export type ClipRow = {
  id: string;
  path: string;
  thumbPath: string | null;
  sizeBytes: number;
  createdAt: Date | string;
};

const DAY_MS = 86_400_000;

// Pure: which clips are older than the retention window.
export function selectExpired(rows: ClipRow[], nowMs: number, retentionDays: number): ClipRow[] {
  const cutoff = nowMs - retentionDays * DAY_MS;
  return rows.filter((r) => new Date(r.createdAt).getTime() < cutoff);
}

// Pure: from oldest-first rows, which to drop so the total stays <= maxBytes.
export function selectOverCap(rowsOldestFirst: ClipRow[], maxBytes: number): ClipRow[] {
  let total = rowsOldestFirst.reduce((s, r) => s + r.sizeBytes, 0);
  const out: ClipRow[] = [];
  for (const r of rowsOldestFirst) {
    if (total <= maxBytes) break;
    out.push(r);
    total -= r.sizeBytes;
  }
  return out;
}

async function deleteClip(r: ClipRow): Promise<void> {
  await fs.rm(join(env.RECORDINGS_DIR, r.path), { force: true }).catch(() => {});
  if (r.thumbPath) {
    await fs.rm(join(env.RECORDINGS_DIR, r.thumbPath), { force: true }).catch(() => {});
  }
  await db.delete(clips).where(eq(clips.id, r.id));
}

// Delete expired clips, then evict oldest until under the size cap. Returns count.
export async function runRetentionOnce(nowMs = Date.now()): Promise<number> {
  const rows = (await db
    .select({
      id: clips.id,
      path: clips.path,
      thumbPath: clips.thumbPath,
      sizeBytes: clips.sizeBytes,
      createdAt: clips.createdAt,
    })
    .from(clips)
    .orderBy(asc(clips.createdAt))) as ClipRow[];

  const expired = selectExpired(rows, nowMs, env.RETENTION_DAYS);
  const expiredIds = new Set(expired.map((r) => r.id));
  const remaining = rows.filter((r) => !expiredIds.has(r.id));
  const over = selectOverCap(remaining, env.MAX_STORAGE_GB * 1024 ** 3);

  const toDelete = [...expired, ...over];
  for (const r of toDelete) await deleteClip(r);
  return toDelete.length;
}

export function startRetention(): void {
  const run = () =>
    void runRetentionOnce().catch((e) =>
      console.error("[retention]", (e as Error).message),
    );
  run(); // once on boot
  setInterval(run, 5 * 60 * 1000);
  console.log("[retention] pruner started (age + size)");
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && bun test test/retention.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Wire the pruner into server boot**

In `backend/src/index.ts`, add the import and start it next to `startIngest()`:

```ts
import { startRetention } from "./realtime/retention";
// ...
startIngest();
startRetention();
```

- [ ] **Step 7: Commit**

```bash
git add backend/src/realtime/retention.ts backend/test/retention.test.ts backend/src/env.ts backend/src/index.ts
git commit -m "feat(api): clip retention pruner (age + size)"
```

---

### Task 3: Clip list + delete routes (ownership-scoped)

**Files:**
- Create: `backend/src/clips/routes.ts`
- Modify: `backend/src/app.ts` (mount `/clips`)
- Create: `backend/test/clips.test.ts`

**Interfaces:**
- Consumes: `clips` (Task 1), `verifyToken` from `../auth/jwt`, `cameras` schema.
- Produces: `clipRoutes` (Hono app), and exported helpers `userIdFrom(c): Promise<string|null>` and `ownedClip(userId, id): Promise<Clip|null>` (consumed by Task 4). Routes: `GET /clips`, `DELETE /clips/:id`.

- [ ] **Step 1: Write the failing tests**

Create `backend/test/clips.test.ts` (mirrors the DB self-skip guard in `test/api.test.ts`):

```ts
import { test, expect, beforeAll } from "bun:test";
import { sql } from "drizzle-orm";
import { app } from "../src/app";
import { db } from "../src/db";

let dbUp = false;
beforeAll(async () => {
  try {
    await db.execute(sql`select 1`);
    dbUp = true;
  } catch {
    dbUp = false;
  }
});

const call = (path: string, opts: RequestInit = {}) =>
  app.fetch(new Request(`http://test${path}`, opts));
const json = (b: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(b),
});
const rnd = () => Math.random().toString(36).slice(2, 9);

test("GET /clips without a token is 401", async () => {
  const r = await call("/clips");
  expect(r.status).toBe(401);
});

test("GET /clips rejects a non-uuid camera_id", async () => {
  if (!dbUp) return;
  const r = await call("/auth/signup", json({ username: "clip_" + rnd(), password: "secret12" }));
  const { token } = await r.json();
  const res = await call("/clips?camera_id=not-a-uuid", {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(400);
});

test("GET /clips returns an empty list for a fresh user", async () => {
  if (!dbUp) return;
  const r = await call("/auth/signup", json({ username: "clip2_" + rnd(), password: "secret12" }));
  const { token } = await r.json();
  const res = await call("/clips", { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.clips).toEqual([]);
  expect(body).toHaveProperty("count", 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && bun test test/clips.test.ts`
Expected: FAIL — `/clips` returns 404 (route not mounted), so the 401/400/200 assertions fail.

- [ ] **Step 3: Implement the routes file**

Create `backend/src/clips/routes.ts`:

```ts
import { Hono } from "hono";
import { and, desc, eq, gte, lte, getTableColumns } from "drizzle-orm";
import { promises as fs } from "fs";
import { join } from "path";
import { db } from "../db";
import { clips, cameras } from "../db/schema";
import { verifyToken } from "../auth/jwt";
import { env } from "../env";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const clipRoutes = new Hono();

// Auth that accepts a Bearer header OR a ?token= query param — <video>/<img>
// tags cannot send an Authorization header. Same token the WebSocket uses.
export async function userIdFrom(c: any): Promise<string | null> {
  const q = c.req.query("token");
  const h = c.req.header("Authorization");
  const token = q ?? (h?.startsWith("Bearer ") ? h.slice(7) : undefined);
  if (!token) return null;
  try {
    const p = await verifyToken(token);
    return p.sub;
  } catch {
    return null;
  }
}

// Fetch a clip only if the caller owns its camera.
export async function ownedClip(userId: string, id: string) {
  if (!UUID_RE.test(id)) return null;
  const [row] = await db
    .select(getTableColumns(clips))
    .from(clips)
    .innerJoin(cameras, eq(clips.cameraId, cameras.id))
    .where(and(eq(clips.id, id), eq(cameras.userId, userId)))
    .limit(1);
  return row ?? null;
}

// GET /clips?camera_id=&from=&to=&limit=&offset= — newest first, owner-scoped.
clipRoutes.get("/", async (c) => {
  const userId = await userIdFrom(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);

  const cameraId = c.req.query("camera_id");
  const from = c.req.query("from");
  const to = c.req.query("to");
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50), 1), 200);
  const offset = Math.max(Number(c.req.query("offset") ?? 0), 0);

  if (cameraId && !UUID_RE.test(cameraId)) {
    return c.json({ error: "camera_id must be a uuid" }, 400);
  }

  const conds = [eq(cameras.userId, userId)];
  if (cameraId) conds.push(eq(clips.cameraId, cameraId));
  if (from && !Number.isNaN(Date.parse(from))) conds.push(gte(clips.startTs, new Date(from)));
  if (to && !Number.isNaN(Date.parse(to))) conds.push(lte(clips.startTs, new Date(to)));

  const rows = await db
    .select(getTableColumns(clips))
    .from(clips)
    .innerJoin(cameras, eq(clips.cameraId, cameras.id))
    .where(and(...conds))
    .orderBy(desc(clips.startTs))
    .limit(limit)
    .offset(offset);

  return c.json({ clips: rows, limit, offset, count: rows.length });
});

// DELETE /clips/:id — remove the row and its files.
clipRoutes.delete("/:id", async (c) => {
  const userId = await userIdFrom(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const clip = await ownedClip(userId, c.req.param("id"));
  if (!clip) return c.json({ error: "not found" }, 404);

  await fs.rm(join(env.RECORDINGS_DIR, clip.path), { force: true }).catch(() => {});
  if (clip.thumbPath) {
    await fs.rm(join(env.RECORDINGS_DIR, clip.thumbPath), { force: true }).catch(() => {});
  }
  await db.delete(clips).where(eq(clips.id, clip.id));
  return c.body(null, 204);
});
```

- [ ] **Step 4: Mount the routes**

In `backend/src/app.ts`, add the import and route (next to the `alertRoutes` line):

```ts
import { clipRoutes } from "./clips/routes";
// ...
app.route("/clips", clipRoutes);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && bun test test/clips.test.ts`
Expected: PASS. (The `dbUp`-guarded tests run fully when Postgres is up; the 401 test always runs.)

- [ ] **Step 6: Commit**

```bash
git add backend/src/clips/routes.ts backend/src/app.ts backend/test/clips.test.ts
git commit -m "feat(api): clip list + delete routes (owner-scoped)"
```

---

### Task 4: Clip media serving (video Range + thumbnail)

**Files:**
- Modify: `backend/src/clips/routes.ts` (add two routes)
- Modify: `backend/test/clips.test.ts` (add a case)

**Interfaces:**
- Consumes: `userIdFrom`, `ownedClip` (Task 3), `Bun.file`.
- Produces: `GET /clips/:id/video` (HTTP Range → 206), `GET /clips/:id/thumb` (image/jpeg).

- [ ] **Step 1: Write the failing test**

Add to `backend/test/clips.test.ts`:

```ts
test("GET /clips/:id/video 404s for an unknown id (token via query)", async () => {
  if (!dbUp) return;
  const r = await call("/auth/signup", json({ username: "clip3_" + rnd(), password: "secret12" }));
  const { token } = await r.json();
  const res = await call(`/clips/11111111-1111-1111-1111-111111111111/video?token=${token}`);
  expect(res.status).toBe(404);
});

test("GET /clips/:id/video without any token is 401", async () => {
  const res = await call("/clips/11111111-1111-1111-1111-111111111111/video");
  expect(res.status).toBe(401);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && bun test test/clips.test.ts`
Expected: FAIL — the video route doesn't exist yet (404 for a missing route also returns 404, but the 401 case fails because there's no handler returning 401).

- [ ] **Step 3: Implement the media routes**

Append to `backend/src/clips/routes.ts` (imports `join`, `env`, `Bun` already available):

```ts
// GET /clips/:id/video — streams MP4 with HTTP Range support so the browser can
// seek/scrub. Auth via header or ?token=.
clipRoutes.get("/:id/video", async (c) => {
  const userId = await userIdFrom(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const clip = await ownedClip(userId, c.req.param("id"));
  if (!clip) return c.json({ error: "not found" }, 404);

  const file = Bun.file(join(env.RECORDINGS_DIR, clip.path));
  if (!(await file.exists())) return c.json({ error: "gone" }, 404);
  const size = file.size;
  const range = c.req.header("range");

  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = m ? Number(m[1]) : 0;
    const end = m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      return new Response("", { status: 416, headers: { "content-range": `bytes */${size}` } });
    }
    return new Response(file.slice(start, end + 1), {
      status: 206,
      headers: {
        "content-type": "video/mp4",
        "content-range": `bytes ${start}-${end}/${size}`,
        "accept-ranges": "bytes",
        "content-length": String(end - start + 1),
      },
    });
  }

  return new Response(file, {
    headers: {
      "content-type": "video/mp4",
      "content-length": String(size),
      "accept-ranges": "bytes",
    },
  });
});

// GET /clips/:id/thumb — jpeg poster.
clipRoutes.get("/:id/thumb", async (c) => {
  const userId = await userIdFrom(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const clip = await ownedClip(userId, c.req.param("id"));
  if (!clip || !clip.thumbPath) return c.json({ error: "not found" }, 404);

  const file = Bun.file(join(env.RECORDINGS_DIR, clip.thumbPath));
  if (!(await file.exists())) return c.json({ error: "gone" }, 404);
  return new Response(file, { headers: { "content-type": "image/jpeg" } });
});
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && bun test test/clips.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/clips/routes.ts backend/test/clips.test.ts
git commit -m "feat(api): serve clip video (HTTP Range) + thumbnail"
```

---

### Task 5: Ingest `clip_ready` + WS fan-out + alert→clip link

**Files:**
- Modify: `backend/src/realtime/channels.ts` (add `clips` channel)
- Modify: `backend/src/realtime/ingest.ts` (subscribe + `onClip`)
- Modify: `backend/src/alerts/routes.ts` (left-join `clipId`)

**Interfaces:**
- Consumes: `clips` table, `ownerOf`, `sendToUser`.
- Produces: DB rows from `clip_ready` events; WS envelope `{ channel: "clip", data }`; `alerts` list rows now carry `clipId: string | null`.

- [ ] **Step 1: Add the Redis channel**

In `backend/src/realtime/channels.ts`, add to `CHANNELS`:

```ts
  clips: "clips", // worker -> API (clip_ready)
```

- [ ] **Step 2: Subscribe + handle `clip_ready`**

In `backend/src/realtime/ingest.ts`:

1. Extend the schema import: `import { alerts, cameras, clips } from "../db/schema";`
2. Add `CHANNELS.clips` to the `redisSub.subscribe(...)` list.
3. Add the dispatch branch inside `redisSub.on("message", ...)`:

```ts
    else if (channel === CHANNELS.clips) void onClip(msg);
```

4. Update the log line to `"[ingest] subscribed to detections, stats, webrtc:answers, clips"`.
5. Add the handler:

```ts
async function onClip(k: any) {
  if (!k?.id || !k?.camera_id || !k?.path) return;
  const base = {
    id: k.id,
    cameraId: k.camera_id,
    backend: k.backend ?? "local",
    path: k.path,
    thumbPath: k.thumb_path ?? null,
    startTs: new Date(k.start_ts),
    endTs: new Date(k.end_ts),
    durationMs: k.duration_ms ?? 0,
    sizeBytes: k.size_bytes ?? 0,
  };
  try {
    await db.insert(clips).values({ ...base, alertId: k.alert_id ?? null }).onConflictDoNothing();
  } catch {
    // The alert row may not have landed yet (FK). Store the clip unlinked
    // rather than lose it.
    try {
      await db.insert(clips).values({ ...base, alertId: null }).onConflictDoNothing();
    } catch (e) {
      console.error("[ingest] clip insert failed:", (e as Error).message);
      return;
    }
  }
  const owner = await ownerOf(k.camera_id);
  if (owner) sendToUser(owner, { channel: "clip", data: k });
}
```

- [ ] **Step 3: Add `clipId` to the alerts list**

In `backend/src/alerts/routes.ts`:

1. Extend the import: `import { alerts, cameras, clips } from "../db/schema";`
2. Replace the `select(...).from(alerts).innerJoin(...)` chain with a left-joined select that carries the clip id:

```ts
  const rows = await db
    .select({ ...getTableColumns(alerts), clipId: clips.id })
    .from(alerts)
    .innerJoin(cameras, eq(alerts.cameraId, cameras.id))
    .leftJoin(clips, eq(clips.alertId, alerts.id))
    .where(and(...conds))
    .orderBy(desc(alerts.ts))
    .limit(limit)
    .offset(offset);
```

- [ ] **Step 4: Typecheck + run the backend suite**

Run: `cd backend && bunx tsc --noEmit && bun test`
Expected: no type errors; all tests pass (DB-guarded ones run if Postgres is up). The alerts test still passes and rows now include `clipId` (null when no clip).

- [ ] **Step 5: Commit**

```bash
git add backend/src/realtime/channels.ts backend/src/realtime/ingest.ts backend/src/alerts/routes.ts
git commit -m "feat(api): ingest clip_ready, fan out over WS, link alerts to clips"
```

---

### Task 6: Worker `Recorder` core logic (pure, TDD)

**Files:**
- Create: `worker/app/recorder.py`
- Create: `worker/tests/test_recorder.py`

**Interfaces:**
- Produces: `Recorder(camera_id, recordings_dir, pre_roll_ms, post_roll_ms, max_clip_len_ms, emit, worker_id, backend="local", margin_ms=2000, muxer_factory=None, thumb_writer=None, id_factory=..., now_iso=..., clock=...)` with methods `set_stream(stream)`, `on_packet(packet, t_ms=None)`, `trigger(thumb_bgr, alert_id, t_ms=None)`, `close()`. A *packet* is any object with `.dts` (int|None), `.pts`, `.is_keyframe` (bool). A *muxer* has `mux(packet)`, `close()`, `size()`. `emit(channel, payload)` is called with `("clips", {clip_ready dict})` on finalize.

- [ ] **Step 1: Write the failing tests**

Create `worker/tests/test_recorder.py`:

```python
import unittest

from app.recorder import Recorder


class FakePacket:
    def __init__(self, dts, is_keyframe):
        self.dts = dts
        self.pts = dts
        self.is_keyframe = is_keyframe


class FakeMuxer:
    def __init__(self, path, stream):
        self.path = path
        self.stream = stream
        self.muxed = []
        self.closed = False

    def mux(self, packet):
        self.muxed.append(packet)

    def close(self):
        self.closed = True

    def size(self):
        return 100 * len(self.muxed)


def make_recorder():
    emitted = []
    muxers = []

    def factory(path, stream):
        m = FakeMuxer(path, stream)
        muxers.append(m)
        return m

    ids = iter([f"clip{i}" for i in range(100)])
    r = Recorder(
        camera_id="cam1",
        recordings_dir="/rec",
        pre_roll_ms=10_000,
        post_roll_ms=10_000,
        max_clip_len_ms=120_000,
        emit=lambda ch, p: emitted.append((ch, p)),
        worker_id="worker-1",
        margin_ms=2000,
        muxer_factory=factory,
        thumb_writer=lambda path, bgr: None,
        id_factory=lambda: next(ids),
        now_iso=lambda: "2026-07-06T00:00:00Z",
    )
    r.set_stream(object())
    return r, emitted, muxers


class TestRecorder(unittest.TestCase):
    def test_trigger_writes_preroll_from_keyframe(self):
        r, emitted, muxers = make_recorder()
        r.on_packet(FakePacket(0, True), t_ms=0)
        r.on_packet(FakePacket(1, False), t_ms=1000)
        r.on_packet(FakePacket(2, False), t_ms=2000)
        r.trigger(thumb_bgr=None, alert_id="a1", t_ms=3000)
        self.assertEqual(len(muxers), 1)
        # all three buffered packets are the pre-roll (start at the only keyframe)
        self.assertEqual(len(muxers[0].muxed), 3)

    def test_second_trigger_extends_not_new_clip(self):
        r, emitted, muxers = make_recorder()
        r.on_packet(FakePacket(0, True), t_ms=0)
        r.trigger(None, "a1", t_ms=1000)  # start, stop_at = 11000
        r.trigger(None, "a2", t_ms=5000)  # extend, stop_at = 15000
        self.assertEqual(len(muxers), 1)
        self.assertIsNotNone(r._active)
        self.assertEqual(r._active.stop_at, 15000)

    def test_finalize_after_post_roll_emits_clip_ready(self):
        r, emitted, muxers = make_recorder()
        r.on_packet(FakePacket(0, True), t_ms=0)
        r.trigger(None, "a1", t_ms=1000)  # stop_at = 11000
        r.on_packet(FakePacket(1, False), t_ms=12000)  # past stop -> finalize
        self.assertEqual(len(emitted), 1)
        ch, p = emitted[0]
        self.assertEqual(ch, "clips")
        self.assertEqual(p["type"], "clip_ready")
        self.assertEqual(p["id"], "clip0")
        self.assertEqual(p["alert_id"], "a1")
        self.assertEqual(p["camera_id"], "cam1")
        self.assertEqual(p["path"], "cam1/clip0.mp4")
        self.assertEqual(p["thumb_path"], "cam1/clip0.jpg")
        self.assertTrue(muxers[0].closed)

    def test_max_clip_len_forces_finalize(self):
        r, emitted, muxers = make_recorder()
        r.on_packet(FakePacket(0, True), t_ms=0)
        r.trigger(None, "a1", t_ms=0)
        # a packet arriving past the max clip length finalizes regardless of stop_at
        r.on_packet(FakePacket(1, False), t_ms=121_000)
        self.assertEqual(len(emitted), 1)

    def test_close_finalizes_in_progress_clip(self):
        r, emitted, muxers = make_recorder()
        r.on_packet(FakePacket(0, True), t_ms=0)
        r.trigger(None, "a1", t_ms=1000)
        r.close()
        self.assertEqual(len(emitted), 1)

    def test_packet_without_dts_is_ignored(self):
        r, emitted, muxers = make_recorder()
        r.on_packet(FakePacket(None, False), t_ms=0)  # flush packet
        self.assertEqual(len(r._buf), 0)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd worker && python -m unittest tests.test_recorder -v`
Expected: FAIL — `No module named 'app.recorder'`.

- [ ] **Step 3: Implement `recorder.py`**

Create `worker/app/recorder.py`:

```python
import os
import uuid
from collections import deque
from datetime import datetime, timezone


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _monotonic_ms() -> float:
    import time

    return time.monotonic() * 1000.0


def _default_muxer_factory(full_path, stream):
    # heavy import kept local so unit tests can import Recorder without PyAV
    from .recorder_io import Mp4Muxer

    return Mp4Muxer(full_path, stream)


def _default_thumb_writer(full_path, bgr):
    import cv2  # local import — not needed by the pure logic tests

    os.makedirs(os.path.dirname(full_path), exist_ok=True)
    cv2.imwrite(full_path, bgr)


class _ActiveClip:
    def __init__(self, clip_id, rel_path, thumb_rel, muxer, start_t, stop_at, alert_id, start_iso):
        self.clip_id = clip_id
        self.rel_path = rel_path
        self.thumb_rel = thumb_rel
        self.muxer = muxer
        self.start_t = start_t
        self.stop_at = stop_at
        self.alert_id = alert_id
        self.start_iso = start_iso
        self.last_t = start_t

    def mux(self, packet, t):
        self.muxer.mux(packet)
        self.last_t = t

    def duration_ms(self, t):
        return t - self.start_t


class Recorder:
    """Event-clip recording for ONE camera. Pure of PyAV/cv2 — the muxer,
    thumbnail writer, id source, clock and now_iso are injected so the
    trigger/extend/finalize/keyframe logic is fully unit-testable with fakes.

    A packet is any object with ``.dts`` (int|None), ``.pts`` and
    ``.is_keyframe`` (bool). A clip must start on a keyframe.
    """

    def __init__(
        self,
        camera_id,
        recordings_dir,
        pre_roll_ms,
        post_roll_ms,
        max_clip_len_ms,
        emit,
        worker_id,
        backend="local",
        margin_ms=2000,
        muxer_factory=None,
        thumb_writer=None,
        id_factory=lambda: str(uuid.uuid4()),
        now_iso=_now_iso,
        clock=_monotonic_ms,
    ):
        self.camera_id = camera_id
        self.recordings_dir = recordings_dir
        self.pre_roll_ms = pre_roll_ms
        self.post_roll_ms = post_roll_ms
        self.max_clip_len_ms = max_clip_len_ms
        self.margin_ms = margin_ms
        self.backend = backend
        self.worker_id = worker_id
        self._emit = emit
        self._muxer_factory = muxer_factory or _default_muxer_factory
        self._thumb_writer = thumb_writer or _default_thumb_writer
        self._id = id_factory
        self._now_iso = now_iso
        self._clock = clock
        self._stream = None
        self._buf = deque()  # (packet, t_ms)
        self._active = None

    def set_stream(self, stream):
        self._stream = stream

    def on_packet(self, packet, t_ms=None):
        if packet.dts is None:
            return
        t = self._clock() if t_ms is None else t_ms
        self._buf.append((packet, t))
        self._trim(t)
        if self._active is not None:
            self._active.mux(packet, t)
            if t >= self._active.stop_at or self._active.duration_ms(t) >= self.max_clip_len_ms:
                self._finalize(t)

    def trigger(self, thumb_bgr, alert_id, t_ms=None):
        t = self._clock() if t_ms is None else t_ms
        if self._active is not None:
            # extend the post-roll, capped by the max clip length
            self._active.stop_at = min(
                t + self.post_roll_ms, self._active.start_t + self.max_clip_len_ms
            )
            return
        clip_id = self._id()
        rel = os.path.join(self.camera_id, f"{clip_id}.mp4")
        thumb_rel = os.path.join(self.camera_id, f"{clip_id}.jpg")
        muxer = self._muxer_factory(os.path.join(self.recordings_dir, rel), self._stream)
        active = _ActiveClip(
            clip_id, rel, thumb_rel, muxer, t, t + self.post_roll_ms, alert_id, self._now_iso()
        )
        for pkt, pt in self._preroll_packets(t):
            active.mux(pkt, pt)
        self._active = active
        self._thumb_writer(os.path.join(self.recordings_dir, thumb_rel), thumb_bgr)

    def close(self):
        """Camera stopping: finalize any in-progress clip."""
        if self._active is not None:
            self._finalize(self._active.last_t)

    # ---- internals ----
    def _trim(self, t):
        cutoff = t - self.pre_roll_ms - self.margin_ms
        while len(self._buf) > 1 and self._buf[0][1] < cutoff:
            self._buf.popleft()

    def _preroll_packets(self, t):
        target = t - self.pre_roll_ms
        items = list(self._buf)
        kf = None
        for i, (p, pt) in enumerate(items):
            if p.is_keyframe and pt <= target:
                kf = i  # newest keyframe at/before the pre-roll start
        if kf is None:
            for i, (p, pt) in enumerate(items):
                if p.is_keyframe:
                    kf = i  # fall back to the earliest keyframe we have
                    break
        if kf is None:
            return []
        return items[kf:]

    def _finalize(self, t):
        a = self._active
        self._active = None
        a.muxer.close()
        payload = {
            "type": "clip_ready",
            "id": str(a.clip_id),
            "alert_id": a.alert_id,
            "camera_id": self.camera_id,
            "start_ts": a.start_iso,
            "end_ts": self._now_iso(),
            "duration_ms": int(a.duration_ms(t)),
            "size_bytes": int(a.muxer.size()),
            "path": a.rel_path,
            "thumb_path": a.thumb_rel,
            "backend": self.backend,
            "worker_id": self.worker_id,
        }
        self._emit("clips", payload)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd worker && python -m unittest tests.test_recorder -v`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/app/recorder.py worker/tests/test_recorder.py
git commit -m "feat(worker): event-clip Recorder core (ring buffer + keyframe trim)"
```

---

### Task 7: Real muxer + wire Recorder into the camera pipeline

**Files:**
- Create: `worker/app/recorder_io.py`
- Modify: `worker/app/config.py` (recording env)
- Modify: `worker/app/camera_worker.py` (demux→decode loop, construct + drive Recorder)
- Modify: `docs/EVENT_FORMAT.md` (document `clip_ready`)

**Interfaces:**
- Consumes: `Recorder` (Task 6), PyAV `av`, OpenCV `cv2`.
- Produces: `Mp4Muxer(full_path, template_stream)` with `mux`/`close`/`size`; a `Recorder` instance per `CameraWorker` fed by the decode loop; `clip_ready` published on Redis `clips` via the worker's existing event queue.

- [ ] **Step 1: Add recording config**

Append to `worker/app/config.py`:

```python
# recording (M1)
PRE_ROLL_S = _int("PRE_ROLL_S", 10)
POST_ROLL_S = _int("POST_ROLL_S", 10)
MAX_CLIP_LEN_S = _int("MAX_CLIP_LEN_S", 120)
RECORDINGS_DIR = os.environ.get("RECORDINGS_DIR", "/recordings")
STORAGE_BACKEND = os.environ.get("STORAGE_BACKEND", "local")
```

- [ ] **Step 2: Implement the real MP4 muxer**

Create `worker/app/recorder_io.py`:

```python
import os

import av


class Mp4Muxer:
    """Remuxes demuxed H.264 packets into a faststart MP4 by codec-copy — no
    re-encode. Timestamps are rebased so the clip starts near zero."""

    def __init__(self, path, template_stream):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self._path = path
        self._c = av.open(path, mode="w", options={"movflags": "+faststart"})
        self._out = self._c.add_stream(template=template_stream)
        self._first_dts = None

    def mux(self, packet):
        if packet.dts is None:
            return
        if self._first_dts is None:
            self._first_dts = packet.dts
        if packet.pts is not None:
            packet.pts = packet.pts - self._first_dts
        packet.dts = packet.dts - self._first_dts
        packet.stream = self._out
        self._c.mux(packet)

    def close(self):
        try:
            self._c.close()
        except Exception:
            pass

    def size(self):
        try:
            return os.path.getsize(self._path)
        except OSError:
            return 0
```

- [ ] **Step 3: Construct the Recorder in `CameraWorker.__init__`**

In `worker/app/camera_worker.py`:

1. Extend imports at the top:

```python
from .config import (
    DETECT_EVERY_N,
    WORKER_ID,
    PRE_ROLL_S,
    POST_ROLL_S,
    MAX_CLIP_LEN_S,
    RECORDINGS_DIR,
    STORAGE_BACKEND,
)
from .recorder import Recorder
```

2. At the end of `__init__` (after `self._det_times = []`), add:

```python
        self.recorder = Recorder(
            camera_id=str(camera_id),
            recordings_dir=RECORDINGS_DIR,
            pre_roll_ms=PRE_ROLL_S * 1000,
            post_roll_ms=POST_ROLL_S * 1000,
            max_clip_len_ms=MAX_CLIP_LEN_S * 1000,
            emit=lambda ch, p: self._evq.put((ch, p)),
            worker_id=WORKER_ID,
            backend=STORAGE_BACKEND,
        )
```

- [ ] **Step 4: Switch the decode loop to demux→decode and drive the recorder**

In `worker/app/camera_worker.py`, replace the body of `_decode_loop` from `self._push_state("live")` through the end of the method with:

```python
        self._push_state("live")
        self.recorder.set_stream(stream)
        frame_count = 0
        frames_since = 0
        last_fps_t = _now_ms()
        try:
            for packet in container.demux(stream):
                if self._stop.is_set():
                    break
                for frame in packet.decode():
                    if self._stop.is_set():
                        break
                    img = frame.to_ndarray(format="bgr24")
                    frame_count += 1
                    frames_since += 1

                    now = _now_ms()
                    if now - last_fps_t >= 1000:
                        self._fps = frames_since * 1000.0 / (now - last_fps_t)
                        frames_since = 0
                        last_fps_t = now

                    boxes = []
                    if frame_count % DETECT_EVERY_N == 0:
                        boxes = self.detector.detect_persons(img)

                    annotated = self._annotate(img, boxes)
                    if boxes:
                        self._maybe_emit_detection(img, boxes, now, annotated)

                    self.latest_frame = VideoFrame.from_ndarray(annotated, format="bgr24")

                # buffer/record the compressed packet AFTER decoding it, so any
                # timestamp rebasing during muxing can't disturb the decoder.
                self.recorder.on_packet(packet)
        except Exception as e:
            log.exception("decode loop failed: %s", self.camera_id)
            self._push_state("error", str(e)[:200])
        finally:
            try:
                self.recorder.close()
            except Exception:
                pass
            try:
                container.close()
            except Exception:
                pass
```

- [ ] **Step 5: Trigger the recorder when a detection is emitted**

In `worker/app/camera_worker.py`, change `_maybe_emit_detection` to accept the annotated frame and trigger the recorder after enqueuing the event:

```python
    def _maybe_emit_detection(self, img, boxes, now_ms: float, annotated) -> None:
        self._det_times.append(now_ms)
        count = len(boxes)
        if not self.limiter.should_emit(self.camera_id, count, now_ms):
            return
        h, w = img.shape[:2]
        conf = max(b.conf for b in boxes)
        payload = detection_event(
            self.camera_id,
            conf,
            count,
            [
                {
                    "x": round(b.x, 4),
                    "y": round(b.y, 4),
                    "w": round(b.w, 4),
                    "h": round(b.h, 4),
                    "conf": b.conf,
                }
                for b in boxes
            ],
            w,
            h,
            WORKER_ID,
        )
        self._evq.put(("detections", payload))
        # start/extend an event clip, using this detection's id as the link
        self.recorder.trigger(annotated, payload["id"])
```

- [ ] **Step 6: Document the `clip_ready` event**

In `docs/EVENT_FORMAT.md`, add a new section after §4 (renumber the WS envelope note if needed) and add `clip` to the envelope's channel list:

````markdown
## 6. Clip ready (Worker → Redis → API → DB → WS)

Emitted by the worker when an event-clip finishes writing (~POST_ROLL after the
last triggering detection). Channel: `clips`. Persisted to the `clips` table;
the API links it to the alert via `alert_id` and fans it out as a `clip`
envelope. `path`/`thumb_path` are relative to `RECORDINGS_DIR`.

```json
{
  "type": "clip_ready",
  "id": "9c2a...",                       // UUID, worker-generated (idempotency key)
  "alert_id": "1f0e...",                 // the detection/alert that triggered it
  "camera_id": "f6c1...",
  "start_ts": "2026-07-06T13:59:01.500Z",
  "end_ts":   "2026-07-06T13:59:21.500Z",
  "duration_ms": 20000,
  "size_bytes": 1830000,
  "path": "f6c1.../9c2a....mp4",
  "thumb_path": "f6c1.../9c2a....jpg",
  "backend": "local",
  "worker_id": "worker-1"
}
```

The WebSocket envelope (§5) `channel` may also be `clip`, whose `data` is the
payload above.
````

- [ ] **Step 7: Run the worker suite**

Run: `cd worker && python -m unittest discover -s tests -v`
Expected: PASS — existing dedup/event tests plus the new recorder tests. (No `av`/`cv2` needed; they're only imported when the real muxer/thumb writer run.)

- [ ] **Step 8: Commit**

```bash
git add worker/app/recorder_io.py worker/app/config.py worker/app/camera_worker.py docs/EVENT_FORMAT.md
git commit -m "feat(worker): record event clips via codec-copy remux + emit clip_ready"
```

---

### Task 8: Frontend types + API client

**Files:**
- Modify: `frontend/lib/types.ts` (add `Clip`, extend `Alert`)
- Modify: `frontend/lib/api.ts` (list/delete + URL helpers)

**Interfaces:**
- Produces: `Clip` type; `Alert.clipId?: string | null`; `api.listClips(cameraId?, limit?)`, `api.deleteClip(id)`, `clipVideoUrl(id)`, `clipThumbUrl(id)`.

- [ ] **Step 1: Add types**

In `frontend/lib/types.ts`, add `clipId` to `Alert` and append the `Clip` type:

```ts
export type Alert = {
  id: string;
  cameraId: string;
  type: string;
  ts: string;
  confidence: number;
  count: number;
  bboxes: unknown;
  frameW: number | null;
  frameH: number | null;
  workerId: string | null;
  clipId?: string | null;
};

export type Clip = {
  id: string;
  cameraId: string;
  alertId: string | null;
  backend: string;
  path: string;
  thumbPath: string | null;
  startTs: string;
  endTs: string;
  durationMs: number;
  sizeBytes: number;
  createdAt: string;
};
```

- [ ] **Step 2: Add API calls + URL helpers**

In `frontend/lib/api.ts`, add to the `api` object (after `listAlerts`):

```ts
  listClips: (cameraId?: string, limit = 50) =>
    req(`/clips?${cameraId ? `camera_id=${cameraId}&` : ""}limit=${limit}`),
  deleteClip: (id: string) => req(`/clips/${id}`, { method: "DELETE" }),
```

And export URL helpers at the end of the file (they embed the token as a query
param because `<video>`/`<img>` can't set an Authorization header):

```ts
export function clipVideoUrl(id: string) {
  return `${API_URL}/clips/${id}/video?token=${getToken() ?? ""}`;
}
export function clipThumbUrl(id: string) {
  return `${API_URL}/clips/${id}/thumb?token=${getToken() ?? ""}`;
}
```

- [ ] **Step 3: Typecheck via build**

Run: `cd frontend && npm run build`
Expected: build succeeds (these are additive; no consumers yet).

- [ ] **Step 4: Commit**

```bash
git add frontend/lib/types.ts frontend/lib/api.ts
git commit -m "feat(web): clip types + api client (list/delete/urls)"
```

---

### Task 9: Live clip → alert play button + player modal

**Files:**
- Create: `frontend/components/ClipPlayer.tsx`
- Modify: `frontend/lib/realtime.ts` (handle `clip` channel)
- Modify: `frontend/app/dashboard/page.tsx` (attach clip to alert; own the player)
- Modify: `frontend/components/CameraTile.tsx` (thumbnail + play button per alert)
- Modify: `frontend/app/globals.css` (modal + thumb styles)

**Interfaces:**
- Consumes: `clipVideoUrl`, `clipThumbUrl`, `Alert.clipId`.
- Produces: `useRealtime` also returns `clipBump: { alertId, cameraId, clip } | null`; `CameraTile` gains an `onPlayClip(clipId)` prop; `ClipPlayer` component.

- [ ] **Step 1: Surface `clip` events from the WS hook**

In `frontend/lib/realtime.ts`:

1. Add state near the other `useState` calls:

```ts
  const [clipBump, setClipBump] = useState<{
    alertId: string | null;
    cameraId: string;
    clip: any;
  } | null>(null);
```

2. In `ws.onmessage`, add a branch after the `alert` branch:

```ts
        } else if (msg.channel === "clip") {
          setClipBump({
            alertId: msg.data.alert_id ?? null,
            cameraId: msg.data.camera_id,
            clip: msg.data,
          });
```

3. Add `clipBump` to the returned object: `return { statsByCam, stateByCam, alertBump, clipBump, connected };`

- [ ] **Step 2: Create the player modal**

Create `frontend/components/ClipPlayer.tsx`:

```tsx
"use client";
import { clipVideoUrl } from "@/lib/api";

// Fullscreen-ish modal that plays one clip. Native <video controls> gives
// scrubbing for free (the API serves HTTP Range).
export function ClipPlayer({ clipId, onClose }: { clipId: string; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <video src={clipVideoUrl(clipId)} controls autoPlay playsInline />
        <div className="modal-actions">
          <a href={clipVideoUrl(clipId)} download className="btn">
            Download
          </a>
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Attach clips to alerts + host the player in the dashboard**

In `frontend/app/dashboard/page.tsx`:

1. Import the player and pull `clipBump`:

```tsx
import { ClipPlayer } from "@/components/ClipPlayer";
// ...
const { statsByCam, stateByCam, alertBump, clipBump, connected } = useRealtime(token);
const [playingClip, setPlayingClip] = useState<string | null>(null);
```

2. Add an effect that stamps the incoming clip onto its alert:

```tsx
  // when a clip finishes recording, attach its id to the matching alert
  useEffect(() => {
    if (!clipBump) return;
    setAlertsByCam((prev) => {
      const list = prev[clipBump.cameraId];
      if (!list) return prev;
      return {
        ...prev,
        [clipBump.cameraId]: list.map((a) =>
          a.id === clipBump.alertId ? { ...a, clipId: clipBump.clip.id } : a,
        ),
      };
    });
  }, [clipBump]);
```

3. Pass `onPlayClip` to each `CameraTile`:

```tsx
              onPlayClip={setPlayingClip}
```

4. Render the player near the `CameraForm` block:

```tsx
      {playingClip && (
        <ClipPlayer clipId={playingClip} onClose={() => setPlayingClip(null)} />
      )}
```

- [ ] **Step 4: Show thumbnail + play button per alert in the tile**

In `frontend/components/CameraTile.tsx`:

1. Add to `Props`: `onPlayClip: (clipId: string) => void;` and destructure it.
2. Import the thumb helper: `import { api, ... } from "@/lib/api";` already imports `api`; add `import { clipThumbUrl } from "@/lib/api";`.
3. Replace the alert row markup (inside `alerts.slice(0, 5).map(...)`) with:

```tsx
            <div key={alert.id} className="alert-row">
              {alert.clipId ? (
                <button
                  className="thumb-btn"
                  title="Play clip"
                  onClick={() => onPlayClip(alert.clipId!)}
                >
                  <img src={clipThumbUrl(alert.clipId)} alt="" className="thumb" />
                  <span className="play-badge">▶</span>
                </button>
              ) : (
                <span className="dot" />
              )}
              <span>
                {alert.count} person{alert.count > 1 ? "s" : ""}
              </span>
              <span className="conf">{Math.round((alert.confidence ?? 0) * 100)}%</span>
              <span className="time">{new Date(alert.ts).toLocaleTimeString()}</span>
            </div>
```

- [ ] **Step 5: Add minimal styles**

Append to `frontend/app/globals.css`:

```css
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.modal {
  background: #111;
  padding: 12px;
  border-radius: 8px;
  max-width: 90vw;
  max-height: 90vh;
}
.modal video {
  max-width: 86vw;
  max-height: 74vh;
  display: block;
}
.modal-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 8px;
}
.thumb-btn {
  position: relative;
  padding: 0;
  border: 0;
  background: none;
  cursor: pointer;
  line-height: 0;
}
.thumb {
  width: 48px;
  height: 27px;
  object-fit: cover;
  border-radius: 3px;
}
.play-badge {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 11px;
  text-shadow: 0 0 3px #000;
}
```

- [ ] **Step 6: Build to verify**

Run: `cd frontend && npm run build`
Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git add frontend/components/ClipPlayer.tsx frontend/lib/realtime.ts frontend/app/dashboard/page.tsx frontend/components/CameraTile.tsx frontend/app/globals.css
git commit -m "feat(web): play button + thumbnail per alert, live clip player"
```

---

### Task 10: Events (recordings) page

**Files:**
- Create: `frontend/app/events/page.tsx`
- Modify: `frontend/app/dashboard/page.tsx` (add an "Events" link in the topbar)

**Interfaces:**
- Consumes: `api.listCameras`, `api.listClips`, `clipThumbUrl`, `ClipPlayer`.
- Produces: `/events` route — clip gallery with a camera filter + player.

- [ ] **Step 1: Create the Events page**

Create `frontend/app/events/page.tsx`:

```tsx
"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, getToken, clipThumbUrl } from "@/lib/api";
import { ClipPlayer } from "@/components/ClipPlayer";
import type { Camera, Clip } from "@/lib/types";

export default function EventsPage() {
  const router = useRouter();
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [clips, setClips] = useState<Clip[]>([]);
  const [filter, setFilter] = useState<string>("");
  const [playing, setPlaying] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    api.listCameras().then(setCameras).catch(() => {});
  }, [router]);

  useEffect(() => {
    setLoading(true);
    api
      .listClips(filter || undefined, 100)
      .then((r) => setClips(r.clips))
      .catch(() => setClips([]))
      .finally(() => setLoading(false));
  }, [filter]);

  const nameOf = (id: string) => cameras.find((c) => c.id === id)?.name ?? id.slice(0, 8);

  return (
    <main className="dash">
      <header className="topbar">
        <h1>Recordings</h1>
        <div className="top-actions">
          <a href="/dashboard" className="btn">
            ← Dashboard
          </a>
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">All cameras</option>
            {cameras.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      </header>

      {loading ? (
        <p className="muted center-text">Loading…</p>
      ) : clips.length === 0 ? (
        <p className="muted center-text">No recordings yet.</p>
      ) : (
        <div className="grid">
          {clips.map((clip) => (
            <button key={clip.id} className="clip-card" onClick={() => setPlaying(clip.id)}>
              {clip.thumbPath ? (
                <img src={clipThumbUrl(clip.id)} alt="" className="clip-thumb" />
              ) : (
                <div className="clip-thumb placeholder" />
              )}
              <div className="clip-meta">
                <strong>{nameOf(clip.cameraId)}</strong>
                <span className="time">{new Date(clip.startTs).toLocaleString()}</span>
                <span className="muted small">{Math.round(clip.durationMs / 1000)}s</span>
              </div>
            </button>
          ))}
        </div>
      )}

      {playing && <ClipPlayer clipId={playing} onClose={() => setPlaying(null)} />}
    </main>
  );
}
```

- [ ] **Step 2: Add an Events link to the dashboard topbar**

In `frontend/app/dashboard/page.tsx`, add inside `.top-actions` (before the Logout button):

```tsx
          <a href="/events" className="btn">
            Recordings
          </a>
```

- [ ] **Step 3: Add clip-card styles**

Append to `frontend/app/globals.css`:

```css
.clip-card {
  text-align: left;
  padding: 0;
  border: 1px solid #222;
  border-radius: 8px;
  overflow: hidden;
  background: #111;
  cursor: pointer;
}
.clip-thumb {
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  display: block;
  background: #000;
}
.clip-thumb.placeholder {
  background: #222;
}
.clip-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px;
}
```

- [ ] **Step 4: Build to verify**

Run: `cd frontend && npm run build`
Expected: build succeeds; `/events` appears in the route list.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/events/page.tsx frontend/app/dashboard/page.tsx frontend/app/globals.css
git commit -m "feat(web): recordings/events gallery page"
```

---

### Task 11: Infra — shared recordings volume + env + docs

**Files:**
- Modify: `docker-compose.yml` (named volume, mounts, env)
- Modify: `.env.example` (recording vars)
- Modify: `README.md` (config table rows + a short recording note)

**Interfaces:**
- Produces: a `recordings` Docker volume mounted `rw` on `worker` and `ro` on `backend`, both at `/recordings`; documented env.

- [ ] **Step 1: Add the volume + mounts + env in compose**

In `docker-compose.yml`:

1. Under `backend:`, add a volume mount and the recordings env:

```yaml
    volumes:
      - recordings:/recordings:ro
    environment:
      SEED_RTSP_URL: rtsp://localhost:8554/cam
      RECORDINGS_DIR: /recordings
```

(Keep the existing `SEED_RTSP_URL`; merge it into the `environment` block shown.)

2. Under `worker:`, add a volume mount and recordings env (keep the existing REDIS_URL/API_BASE_URL):

```yaml
    volumes:
      - recordings:/recordings
    environment:
      REDIS_URL: redis://localhost:6379
      API_BASE_URL: http://localhost:8080
      RECORDINGS_DIR: /recordings
```

3. Add the volume to the top-level `volumes:` block:

```yaml
volumes:
  pgdata:
  recordings:
```

- [ ] **Step 2: Document env in `.env.example`**

Append to `.env.example`:

```bash

# ---- recording (M1) ----
# worker
PRE_ROLL_S=10
POST_ROLL_S=10
MAX_CLIP_LEN_S=120
RECORDINGS_DIR=/recordings
STORAGE_BACKEND=local
# backend retention
RETENTION_DAYS=7
MAX_STORAGE_GB=10
```

- [ ] **Step 3: Update the README**

In `README.md`, add rows to the Configuration table:

```markdown
| `PRE_ROLL_S` | `10` | worker | seconds of footage kept before a trigger |
| `POST_ROLL_S` | `10` | worker | seconds recorded after the last trigger |
| `MAX_CLIP_LEN_S` | `120` | worker | hard cap on a single (extended) clip |
| `RECORDINGS_DIR` | `/recordings` | worker, backend | clip/thumbnail storage root (shared volume) |
| `STORAGE_BACKEND` | `local` | worker | clip storage backend |
| `RETENTION_DAYS` | `7` | backend | delete clips older than this |
| `MAX_STORAGE_GB` | `10` | backend | evict oldest clips past this total |
```

And add a one-line mention under Data flow / Future improvements that event clips are now recorded on detection and served from `/clips` (mark the "clip/thumbnail per alert" future-improvement bullet as done).

- [ ] **Step 4: Bring the stack up and smoke-test end to end**

Run: `docker compose up --build`
Then in the browser (http://localhost:3000, demo/demo12345):
1. Start the seeded camera; wait for live video with boxes.
2. When the sample clip shows a person, within ~10s the alert row gains a **thumbnail + ▶**.
3. Click ▶ → the clip plays and **includes footage from ~10s before** the person appeared; scrubbing works.
4. Open **Recordings** → the clip is listed; the camera filter works; download works.
Expected: all of the above. Check `docker compose exec worker ls /recordings/<camera_id>` shows `.mp4` + `.jpg`.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml .env.example README.md
git commit -m "chore(infra): shared recordings volume + recording env + docs"
```

---

## Self-Review

**Spec coverage** (against `docs/superpowers/specs/2026-07-04-m1-recording-playback-design.md`):

- Capture A1 (encoded-packet ring buffer, codec-copy) → Tasks 6, 7. ✔
- Clip lifecycle (keyframe trim, extend, MAX_CLIP_LEN, thumbnail) → Task 6 (logic) + Task 7 (real muxer/thumb). ✔
- Storage local shared volume, fragmented MP4 (`+faststart`) → Tasks 7, 11. ✔
- Retention 7d/10GB, age + size, row+file+thumb → Task 2. ✔
- Data model `clips` + `alertId` on-delete-set-null + `(cameraId, startTs)` index → Task 1. ✔
- `clip_ready` event + `clips` channel + EVENT_FORMAT doc → Tasks 5, 7. ✔
- Alert fires immediately, clip links later over WS `clip` channel → Tasks 5, 9. ✔
- API: `GET /clips`, `GET /clips/:id/video` (Range), `/thumb`, `DELETE`, `?token` media auth, owner-scoping → Tasks 3, 4. ✔
- alerts response gains `clipId` → Task 5. ✔
- Frontend: alert thumb + play (live), Events gallery with filter + player + download → Tasks 8–10. ✔
- Infra: recordings volume rw/ro, env in `.env.example` + `env.ts` + README → Tasks 2 (env.ts), 11. ✔
- Tests: recorder keyframe-trim/extend/finalize/max-len, retention selectors, clips route ownership + Range + token → Tasks 2, 3, 4, 6. ✔

**Clip↔alert 1:1 / triggered only by emitted detection:** `recorder.trigger` is called only inside `_maybe_emit_detection` after `limiter.should_emit` passes (Task 7, Step 5), and uses that detection's `payload["id"]` as `alert_id`. ✔

**Type/name consistency:** `Recorder` constructor and method names match between Task 6 tests and implementation; `userIdFrom`/`ownedClip` exported in Task 3 and reused in Task 4; `clipBump` shape produced in Task 9 Step 1 matches its consumer in Step 3; `clip_ready` field names (`alert_id`, `path`, `thumb_path`, `start_ts`, `end_ts`, `duration_ms`, `size_bytes`) are identical across worker emit (Task 6), ingest (Task 5), and EVENT_FORMAT (Task 7). ✔

**Placeholder scan:** no TBD/TODO; every code step shows complete code. ✔

**Known edge (documented, acceptable for M1):** `clip_ready` may arrive at the API before its detection row is persisted (cross-channel ordering); `onClip` retries with `alertId=null` on FK failure so the clip is never lost (Task 5). Buffered packets are mutated (pts rebase, stream reassignment) when muxed; the single-active-clip invariant and buffer trimming prevent a packet being reused across clips.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-06-m1-recording-playback.md`.
