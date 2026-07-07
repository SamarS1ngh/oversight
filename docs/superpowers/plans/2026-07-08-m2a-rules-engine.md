# M2a Zone & Class Rules Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "any person → alert" firehose with a per-camera rules engine: alert on `{class}` inside `{drawn zone}` during `{schedule}` at a chosen `{severity}`, with an acknowledge/resolve workflow.

**Architecture:** Zones + rules live in the DB (API-owned). The API pushes a camera's enabled rules (with zone polygons inlined) to the worker over Redis on `start` and on any rule/zone change (`rules_update`). The worker runs multi-class YOLO and, per detected object, evaluates it against the camera's rules (class ∈, conf ≥, point-in-polygon on box bottom-center, schedule window) with per-(camera,rule) dedup; a match emits an alert tagged with `label`/`rule_id`/`severity`. Zero rules → a synthesized "any person, low" default. Ack/resolve is an alert-status workflow.

**Tech Stack:** Bun + Hono 4 + Drizzle 0.36 (Postgres), Python + PyAV + OpenCV + ultralytics YOLOv8n, Next.js 15 / React 19, Redis pub/sub.

## Global Constraints

- **Event contract is the single source of truth** in `docs/EVENT_FORMAT.md`; the `start`/`rules_update` command shapes and the detection-event fields (`label`, `rule_id`, `severity`, per-box `label`) must match worker emit ↔ API ingest ↔ DB ↔ frontend.
- **No import-time side effects in `backend/src/app.ts`.** Subscribers/timers live in `index.ts`.
- **Worker rule logic stays import-light:** `worker/app/rules.py` and `dedup.py` must unit-test without torch/av/cv2 (heavy imports local to `detector.py`/`recorder_io.py` only).
- **Ownership scoping everywhere:** zones/rules/alerts are reachable only through the caller's cameras (inner join on `cameras.userId`), like `alerts`/`clips` today.
- **Implicit default:** a camera with zero enabled rules alerts on any `person` at `severity=low`, `ruleId=null` (never silent).
- **Severity enum:** exactly `low | medium | high`. **Alert status enum:** exactly `new | acked | resolved`.
- **"In zone" test:** the box bottom-center `(x + w/2, y + h)`, normalized 0–1, via ray-casting.
- **Schedules:** local-time `HH:MM` windows, wrap-around allowed; compared in the worker's tz (`TZ` env, default UTC). `null`/`null` = always active.
- **Curated class set (COCO id→name):** person 0, bicycle 1, car 2, motorcycle 3, bus 5, truck 7, cat 15, dog 16, backpack 24, handbag 26, suitcase 28.
- **Idempotent alert insert** on the worker `id` (`onConflictDoNothing`).
- **Commits:** author is Samar only. No `Co-Authored-By: Claude` trailer.
- **Pinned deps unchanged.** No new runtime dependencies.
- Commands: backend `cd backend && bun test` (DB-backed tests need `DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms`); migrate `cd backend && bun run db:push`; worker `cd worker && python3 -m unittest discover -s tests -v`; frontend `cd frontend && npm run build`.

---

### Task 1: `zones` + `rules` tables + `alerts` columns + migration

**Files:**
- Modify: `backend/src/db/schema.ts` (append two tables; add columns to `alerts`)

**Interfaces:**
- Produces: `zones` table (`id, cameraId, name, polygon jsonb, createdAt`), `rules` table (`id, cameraId, name, zoneId?, classes jsonb, scheduleStart?, scheduleEnd?, minConfidence, severity, enabled, createdAt, updatedAt`), and `Zone`/`Rule` types. `alerts` gains `label, ruleId?, severity, status, ackedAt?, resolvedAt?`.

- [ ] **Step 1: Add columns to the `alerts` table**

In `backend/src/db/schema.ts`, inside the `alerts` column object (after `workerId: ...`), add:

```ts
    label: text("label"),
    ruleId: uuid("rule_id"),
    severity: text("severity").notNull().default("low"),
    status: text("status").notNull().default("new"),
    ackedAt: timestamp("acked_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
```

(`ruleId` is a plain `uuid` column, not a FK, to avoid an insert-ordering FK failure between the detection event and the rule row and to keep the alert if a rule is later deleted.)

- [ ] **Step 2: Add the `zones` and `rules` tables**

In `backend/src/db/schema.ts`, after the `clips` table and before the `export type` lines, add:

```ts
// A drawn region of interest on a camera. `polygon` is normalized [0,1] points.
export const zones = pgTable(
  "zones",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cameraId: uuid("camera_id")
      .notNull()
      .references(() => cameras.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    polygon: jsonb("polygon").notNull(), // [{ x:0.1, y:0.2 }, ...] normalized, >=3 pts
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({ cameraIdx: index("zones_camera_idx").on(t.cameraId) }),
);

// An alerting rule. Matches when a detected object of one of `classes`, above
// `minConfidence`, (inside `zoneId` if set) fires during the schedule window.
export const rules = pgTable(
  "rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cameraId: uuid("camera_id")
      .notNull()
      .references(() => cameras.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    zoneId: uuid("zone_id").references(() => zones.id, { onDelete: "set null" }),
    classes: jsonb("classes").notNull(), // ["person","car"]
    scheduleStart: text("schedule_start"), // "HH:MM" local, nullable
    scheduleEnd: text("schedule_end"),
    minConfidence: real("min_confidence").notNull().default(0.4),
    severity: text("severity").notNull().default("low"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({ cameraIdx: index("rules_camera_idx").on(t.cameraId) }),
);
```

- [ ] **Step 3: Export the types**

At the bottom of `backend/src/db/schema.ts` add:

```ts
export type Zone = typeof zones.$inferSelect;
export type Rule = typeof rules.$inferSelect;
```

- [ ] **Step 4: Apply the migration**

Run: `cd backend && DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun run db:push`
Expected: drizzle-kit creates `zones`, `rules`, and the new `alerts` columns. (Start `docker compose up -d postgres` first if no DB.)

- [ ] **Step 5: Typecheck + commit**

Run: `cd backend && bunx tsc --noEmit` → no errors.

```bash
git add backend/src/db/schema.ts
git commit -m "feat(db): zones + rules tables, alert rule/severity/status columns"
```

---

### Task 2: Zones CRUD routes

**Files:**
- Create: `backend/src/rules/routes.ts` (holds BOTH zones + rules routers; created here, extended in Task 3)
- Modify: `backend/src/app.ts` (mount)
- Create: `backend/test/rules.test.ts`

**Interfaces:**
- Consumes: `zones` schema, `verifyToken`/`requireAuth`, `cameras`.
- Produces: `zoneRoutes` Hono app mounted at `/cameras/:cameraId/zones`; exported helper `ownedCamera(userId, cameraId)`. Routes: `GET`/`POST`/`PATCH /:zoneId`/`DELETE /:zoneId`.

- [ ] **Step 1: Write the failing tests**

Create `backend/test/rules.test.ts` (mirrors the DB self-skip guard in `test/api.test.ts`):

```ts
import { test, expect, beforeAll } from "bun:test";
import { sql } from "drizzle-orm";
import { app } from "../src/app";
import { db } from "../src/db";

let dbUp = false;
beforeAll(async () => {
  try { await db.execute(sql`select 1`); dbUp = true; } catch { dbUp = false; }
});
const call = (p: string, o: RequestInit = {}) => app.fetch(new Request(`http://test${p}`, o));
const json = (b: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
const rnd = () => Math.random().toString(36).slice(2, 9);
async function user() {
  const r = await call("/auth/signup", json({ username: "r_" + rnd(), password: "secret12" }));
  const { token } = await r.json();
  const authed = (p: string, o: RequestInit = {}) => call(p, { ...o, headers: { ...(o.headers ?? {}), Authorization: `Bearer ${token}` } });
  const cam = await (await authed("/cameras", json({ name: "c", rtsp_url: "rtsp://x/y" }))).json();
  return { token, authed, cam };
}

test("zones require auth", async () => {
  const r = await call("/cameras/11111111-1111-1111-1111-111111111111/zones");
  expect(r.status).toBe(401);
});

test("create + list a zone, scoped to the owner", async () => {
  if (!dbUp) return;
  const a = await user();
  const created = await a.authed(`/cameras/${a.cam.id}/zones`, json({ name: "Driveway", polygon: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.5, y: 0.9 }] }));
  expect(created.status).toBe(201);
  const zone = await created.json();
  expect(zone.name).toBe("Driveway");
  const list = await (await a.authed(`/cameras/${a.cam.id}/zones`)).json();
  expect(list.map((z: any) => z.id)).toContain(zone.id);
  // another user cannot see it
  const b = await user();
  const bl = await b.authed(`/cameras/${a.cam.id}/zones`);
  expect(bl.status).toBe(404);
});

test("reject a polygon with fewer than 3 points", async () => {
  if (!dbUp) return;
  const a = await user();
  const r = await a.authed(`/cameras/${a.cam.id}/zones`, json({ name: "bad", polygon: [{ x: 0.1, y: 0.1 }] }));
  expect(r.status).toBe(400);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd backend && bun test test/rules.test.ts`
Expected: FAIL — `/cameras/:id/zones` returns 404 (not mounted).

- [ ] **Step 3: Implement the zones router**

Create `backend/src/rules/routes.ts`:

```ts
import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { zones, cameras } from "../db/schema";
import { requireAuth } from "../auth/middleware";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function ownedCamera(userId: string, cameraId: string) {
  if (!UUID_RE.test(cameraId)) return null;
  const [cam] = await db
    .select()
    .from(cameras)
    .where(and(eq(cameras.id, cameraId), eq(cameras.userId, userId)))
    .limit(1);
  return cam ?? null;
}

function validPolygon(p: unknown): p is { x: number; y: number }[] {
  return (
    Array.isArray(p) &&
    p.length >= 3 &&
    p.every(
      (pt: any) =>
        pt && typeof pt.x === "number" && typeof pt.y === "number" &&
        pt.x >= 0 && pt.x <= 1 && pt.y >= 0 && pt.y <= 1,
    )
  );
}

// mounted at /cameras/:cameraId/zones
export const zoneRoutes = new Hono();
zoneRoutes.use("*", requireAuth);

zoneRoutes.get("/", async (c) => {
  const cam = await ownedCamera(c.get("userId"), c.req.param("cameraId"));
  if (!cam) return c.json({ error: "not found" }, 404);
  const rows = await db.select().from(zones).where(eq(zones.cameraId, cam.id)).orderBy(desc(zones.createdAt));
  return c.json(rows);
});

zoneRoutes.post("/", async (c) => {
  const cam = await ownedCamera(c.get("userId"), c.req.param("cameraId"));
  if (!cam) return c.json({ error: "not found" }, 404);
  const b = await c.req.json().catch(() => null);
  const name = b?.name?.trim();
  if (!name) return c.json({ error: "name required" }, 400);
  if (!validPolygon(b?.polygon)) return c.json({ error: "polygon must be >=3 points in [0,1]" }, 400);
  const [zone] = await db.insert(zones).values({ cameraId: cam.id, name, polygon: b.polygon }).returning();
  return c.json(zone, 201);
});

zoneRoutes.patch("/:zoneId", async (c) => {
  const cam = await ownedCamera(c.get("userId"), c.req.param("cameraId"));
  if (!cam) return c.json({ error: "not found" }, 404);
  const b = await c.req.json().catch(() => ({}));
  const patch: Record<string, unknown> = {};
  if (typeof b.name === "string") patch.name = b.name.trim();
  if (b.polygon !== undefined) {
    if (!validPolygon(b.polygon)) return c.json({ error: "polygon must be >=3 points in [0,1]" }, 400);
    patch.polygon = b.polygon;
  }
  const [updated] = await db
    .update(zones)
    .set(patch)
    .where(and(eq(zones.id, c.req.param("zoneId")), eq(zones.cameraId, cam.id)))
    .returning();
  if (!updated) return c.json({ error: "not found" }, 404);
  return c.json(updated);
});

zoneRoutes.delete("/:zoneId", async (c) => {
  const cam = await ownedCamera(c.get("userId"), c.req.param("cameraId"));
  if (!cam) return c.json({ error: "not found" }, 404);
  await db.delete(zones).where(and(eq(zones.id, c.req.param("zoneId")), eq(zones.cameraId, cam.id)));
  return c.body(null, 204);
});
```

- [ ] **Step 4: Mount it**

In `backend/src/app.ts`, add the import and route (after `app.route("/cameras", cameraRoutes)`):

```ts
import { zoneRoutes } from "./rules/routes";
// ...
app.route("/cameras/:cameraId/zones", zoneRoutes);
```

- [ ] **Step 5: Run to verify pass**

Run: `cd backend && DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun test test/rules.test.ts`
Expected: PASS (3 tests; the 401 test always runs).

- [ ] **Step 6: Commit**

```bash
git add backend/src/rules/routes.ts backend/src/app.ts backend/test/rules.test.ts
git commit -m "feat(api): zones CRUD (owner-scoped, polygon validated)"
```

---

### Task 3: Rules CRUD routes + validation

**Files:**
- Modify: `backend/src/rules/routes.ts` (add `ruleRoutes`)
- Modify: `backend/src/app.ts` (mount)
- Modify: `backend/test/rules.test.ts` (add cases)

**Interfaces:**
- Consumes: `rules`/`zones` schema, `ownedCamera` (Task 2).
- Produces: `ruleRoutes` mounted at `/cameras/:cameraId/rules`; exported `KNOWN_CLASSES: string[]` and `resolveRules(cameraId): Promise<ResolvedRule[]>` where `ResolvedRule = { id, classes, zone: {x,y}[]|null, schedule: [string|null,string|null], min_confidence, severity, enabled }` (consumed by Task 4).

- [ ] **Step 1: Write the failing tests**

Add to `backend/test/rules.test.ts`:

```ts
test("create a rule with a zone + validate inputs", async () => {
  if (!dbUp) return;
  const a = await user();
  const zone = await (await a.authed(`/cameras/${a.cam.id}/zones`, json({ name: "Z", polygon: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.5, y: 0.9 }] }))).json();
  const ok = await a.authed(`/cameras/${a.cam.id}/rules`, json({ name: "night", classes: ["person", "car"], zoneId: zone.id, scheduleStart: "22:00", scheduleEnd: "06:00", severity: "high" }));
  expect(ok.status).toBe(201);
  const rule = await ok.json();
  expect(rule.severity).toBe("high");
  const list = await (await a.authed(`/cameras/${a.cam.id}/rules`)).json();
  expect(list.map((r: any) => r.id)).toContain(rule.id);
});

test("reject unknown class, bad severity, bad schedule", async () => {
  if (!dbUp) return;
  const a = await user();
  const badClass = await a.authed(`/cameras/${a.cam.id}/rules`, json({ name: "x", classes: ["dragon"] }));
  expect(badClass.status).toBe(400);
  const badSev = await a.authed(`/cameras/${a.cam.id}/rules`, json({ name: "x", classes: ["person"], severity: "urgent" }));
  expect(badSev.status).toBe(400);
  const badTime = await a.authed(`/cameras/${a.cam.id}/rules`, json({ name: "x", classes: ["person"], scheduleStart: "9am" }));
  expect(badTime.status).toBe(400);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd backend && bun test test/rules.test.ts` → new tests FAIL (rules route 404).

- [ ] **Step 3: Implement the rules router + resolver**

Append to `backend/src/rules/routes.ts` (add `rules` to the schema import and `getTableColumns` to the drizzle import):

```ts
export const KNOWN_CLASSES = [
  "person", "bicycle", "car", "motorcycle", "bus", "truck",
  "cat", "dog", "backpack", "handbag", "suitcase",
];
const SEVERITIES = ["low", "medium", "high"];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function validateRuleBody(b: any): string | null {
  if (!b?.name?.trim()) return "name required";
  if (!Array.isArray(b.classes) || b.classes.length < 1) return "classes must be a non-empty array";
  if (!b.classes.every((cl: any) => KNOWN_CLASSES.includes(cl))) return "unknown class";
  if (b.severity !== undefined && !SEVERITIES.includes(b.severity)) return "severity must be low|medium|high";
  for (const k of ["scheduleStart", "scheduleEnd"]) {
    if (b[k] !== undefined && b[k] !== null && !HHMM.test(b[k])) return `${k} must be HH:MM`;
  }
  if (b.minConfidence !== undefined && (typeof b.minConfidence !== "number" || b.minConfidence < 0 || b.minConfidence > 1)) return "minConfidence must be 0..1";
  return null;
}

// mounted at /cameras/:cameraId/rules
export const ruleRoutes = new Hono();
ruleRoutes.use("*", requireAuth);

ruleRoutes.get("/", async (c) => {
  const cam = await ownedCamera(c.get("userId"), c.req.param("cameraId"));
  if (!cam) return c.json({ error: "not found" }, 404);
  const rows = await db.select().from(rules).where(eq(rules.cameraId, cam.id)).orderBy(desc(rules.createdAt));
  return c.json(rows);
});

ruleRoutes.post("/", async (c) => {
  const cam = await ownedCamera(c.get("userId"), c.req.param("cameraId"));
  if (!cam) return c.json({ error: "not found" }, 404);
  const b = await c.req.json().catch(() => null);
  const err = validateRuleBody(b);
  if (err) return c.json({ error: err }, 400);
  // if a zone is given it must belong to this camera
  if (b.zoneId) {
    const [z] = await db.select({ id: zones.id }).from(zones).where(and(eq(zones.id, b.zoneId), eq(zones.cameraId, cam.id))).limit(1);
    if (!z) return c.json({ error: "zone not found for this camera" }, 400);
  }
  const [rule] = await db.insert(rules).values({
    cameraId: cam.id,
    name: b.name.trim(),
    zoneId: b.zoneId ?? null,
    classes: b.classes,
    scheduleStart: b.scheduleStart ?? null,
    scheduleEnd: b.scheduleEnd ?? null,
    minConfidence: typeof b.minConfidence === "number" ? b.minConfidence : 0.4,
    severity: b.severity ?? "low",
    enabled: typeof b.enabled === "boolean" ? b.enabled : true,
  }).returning();
  return c.json(rule, 201);
});

ruleRoutes.patch("/:ruleId", async (c) => {
  const cam = await ownedCamera(c.get("userId"), c.req.param("cameraId"));
  if (!cam) return c.json({ error: "not found" }, 404);
  const b = await c.req.json().catch(() => ({}));
  // validate only provided fields by merging onto a minimal valid base
  const merged = { name: b.name ?? "x", classes: b.classes ?? ["person"], severity: b.severity, scheduleStart: b.scheduleStart, scheduleEnd: b.scheduleEnd, minConfidence: b.minConfidence };
  const err = validateRuleBody(merged);
  if (err) return c.json({ error: err }, 400);
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const k of ["name", "classes", "zoneId", "scheduleStart", "scheduleEnd", "minConfidence", "severity", "enabled"]) {
    if (b[k] !== undefined) patch[k === "name" ? "name" : k] = k === "name" ? String(b[k]).trim() : b[k];
  }
  const [updated] = await db.update(rules).set(patch).where(and(eq(rules.id, c.req.param("ruleId")), eq(rules.cameraId, cam.id))).returning();
  if (!updated) return c.json({ error: "not found" }, 404);
  return c.json(updated);
});

ruleRoutes.delete("/:ruleId", async (c) => {
  const cam = await ownedCamera(c.get("userId"), c.req.param("cameraId"));
  if (!cam) return c.json({ error: "not found" }, 404);
  await db.delete(rules).where(and(eq(rules.id, c.req.param("ruleId")), eq(rules.cameraId, cam.id)));
  return c.body(null, 204);
});

// Resolve a camera's ENABLED rules into self-contained payloads (zone polygon
// inlined) for delivery to the worker.
export type ResolvedRule = {
  id: string;
  classes: string[];
  zone: { x: number; y: number }[] | null;
  schedule: [string | null, string | null];
  min_confidence: number;
  severity: string;
  enabled: boolean;
};

export async function resolveRules(cameraId: string): Promise<ResolvedRule[]> {
  const rows = await db
    .select({ ...getTableColumns(rules), zonePolygon: zones.polygon })
    .from(rules)
    .leftJoin(zones, eq(rules.zoneId, zones.id))
    .where(and(eq(rules.cameraId, cameraId), eq(rules.enabled, true)));
  return rows.map((r) => ({
    id: r.id,
    classes: r.classes as string[],
    zone: (r.zonePolygon as { x: number; y: number }[] | null) ?? null,
    schedule: [r.scheduleStart, r.scheduleEnd],
    min_confidence: r.minConfidence,
    severity: r.severity,
    enabled: r.enabled,
  }));
}
```

Update the imports at the top of the file: `import { and, desc, eq, getTableColumns } from "drizzle-orm";` and `import { zones, rules, cameras } from "../db/schema";`.

- [ ] **Step 4: Mount the rules router**

In `backend/src/app.ts` add:

```ts
import { zoneRoutes, ruleRoutes } from "./rules/routes";
// ...
app.route("/cameras/:cameraId/rules", ruleRoutes);
```

(Replace the Task 2 single-name import with this combined import.)

- [ ] **Step 5: Run to verify pass**

Run: `cd backend && DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun test test/rules.test.ts`
Expected: PASS (all zone + rule tests).

- [ ] **Step 6: Commit**

```bash
git add backend/src/rules/routes.ts backend/src/app.ts backend/test/rules.test.ts
git commit -m "feat(api): rules CRUD + validation + resolveRules() resolver"
```

---

### Task 4: Push rules to the worker (`start` embeds rules, `rules_update` on change)

**Files:**
- Modify: `backend/src/realtime/channels.ts` (extend `CameraCommand`, add `publishRulesUpdate`)
- Modify: `backend/src/cameras/routes.ts` (embed rules in `start`)
- Modify: `backend/src/rules/routes.ts` (publish `rules_update` after any zone/rule change on a running camera)

**Interfaces:**
- Consumes: `resolveRules` (Task 3), `publishCommand`.
- Produces: `start` command carries `rules: ResolvedRule[]`; new `rules_update` command `{ type, camera_id, rules, requested_by, ts }`; helper `pushRulesIfRunning(cameraId, userId)`.

- [ ] **Step 1: Extend the command type + add a publisher**

In `backend/src/realtime/channels.ts`, replace the `CameraCommand` union and add a helper:

```ts
export type CameraCommand =
  | {
      type: "start";
      camera_id: string;
      rtsp_url: string;
      rules: unknown[];
      requested_by: string;
      ts: string;
    }
  | { type: "stop"; camera_id: string; requested_by: string; ts: string }
  | { type: "rules_update"; camera_id: string; rules: unknown[]; requested_by: string; ts: string };

export async function publishCommand(cmd: CameraCommand): Promise<void> {
  await redisPub.publish(CHANNELS.commands, JSON.stringify(cmd));
}
```

- [ ] **Step 2: Embed rules in `start`**

In `backend/src/cameras/routes.ts`:
1. Add import: `import { resolveRules } from "../rules/routes";`
2. In the `/:id/start` handler, build rules before publishing and include them:

```ts
  const resolved = await resolveRules(cam.id);
  await publishCommand({
    type: "start",
    camera_id: cam.id,
    rtsp_url: cam.rtspUrl,
    rules: resolved,
    requested_by: c.get("userId"),
    ts: new Date().toISOString(),
  });
```

- [ ] **Step 3: Publish `rules_update` after zone/rule changes on a running camera**

In `backend/src/rules/routes.ts`:
1. Add imports: `import { publishCommand } from "../realtime/channels";`
2. Add the helper (after `resolveRules`):

```ts
// After a zone/rule change, if the camera is currently running, push the fresh
// rule set to the worker so it takes effect without a restart.
export async function pushRulesIfRunning(cam: { id: string; status: string }, userId: string) {
  if (cam.status !== "connecting" && cam.status !== "live") return;
  const resolved = await resolveRules(cam.id);
  await publishCommand({
    type: "rules_update",
    camera_id: cam.id,
    rules: resolved,
    requested_by: userId,
    ts: new Date().toISOString(),
  });
}
```
3. Call `await pushRulesIfRunning(cam, c.get("userId"));` at the end of each successful `POST`/`PATCH`/`DELETE` handler in BOTH `zoneRoutes` and `ruleRoutes` (before the `return`). `cam` is already fetched via `ownedCamera` (it includes `status`).

- [ ] **Step 4: Write a test that a rule change on a running camera publishes `rules_update`**

Add to `backend/test/rules.test.ts` (spy on Redis publish by checking the command channel via a subscriber). Simpler deterministic test — assert `resolveRules` shape through a running-camera create path is not trivially verifiable without Redis, so test the resolver output directly instead:

```ts
import { resolveRules } from "../src/rules/routes";

test("resolveRules inlines the zone polygon and only returns enabled rules", async () => {
  if (!dbUp) return;
  const a = await user();
  const poly = [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.5, y: 0.9 }];
  const zone = await (await a.authed(`/cameras/${a.cam.id}/zones`, json({ name: "Z", polygon: poly }))).json();
  await a.authed(`/cameras/${a.cam.id}/rules`, json({ name: "on", classes: ["person"], zoneId: zone.id, severity: "high" }));
  await a.authed(`/cameras/${a.cam.id}/rules`, json({ name: "off", classes: ["car"], enabled: false }));
  const resolved = await resolveRules(a.cam.id);
  expect(resolved.length).toBe(1);
  expect(resolved[0].zone).toEqual(poly);
  expect(resolved[0].classes).toEqual(["person"]);
  expect(resolved[0].severity).toBe("high");
});
```

- [ ] **Step 5: Run + typecheck**

Run: `cd backend && bunx tsc --noEmit && DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun test test/rules.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/realtime/channels.ts backend/src/cameras/routes.ts backend/src/rules/routes.ts backend/test/rules.test.ts
git commit -m "feat(api): deliver rules to worker on start + rules_update on change"
```

---

### Task 5: Ingest new detection fields + alert filters + ack/resolve

**Files:**
- Modify: `backend/src/realtime/ingest.ts` (`onDetection` maps `label`/`ruleId`/`severity`)
- Modify: `backend/src/alerts/routes.ts` (severity/status filters + ack/resolve)
- Modify: `backend/test/rules.test.ts` (ack/resolve + filter tests)

**Interfaces:**
- Consumes: `alerts` new columns (Task 1).
- Produces: alerts persisted with `label`/`ruleId`/`severity`; `GET /alerts` accepts `severity`/`status`; `POST /alerts/:id/ack` and `/resolve`.

- [ ] **Step 1: Map the new fields in `onDetection`**

In `backend/src/realtime/ingest.ts`, in `onDetection`'s insert `.values({...})`, add:

```ts
        label: d.label ?? null,
        ruleId: d.rule_id ?? null,
        severity: d.severity ?? "low",
```

- [ ] **Step 2: Write failing tests for filters + ack/resolve**

Add to `backend/test/rules.test.ts`:

```ts
import { db } from "../src/db";
import { alerts } from "../src/db/schema";

test("alerts severity/status filter + ack + resolve", async () => {
  if (!dbUp) return;
  const a = await user();
  const id = crypto.randomUUID();
  await db.insert(alerts).values({ id, cameraId: a.cam.id, type: "detection", ts: new Date(), confidence: 0.9, count: 1, label: "person", severity: "high", status: "new" });
  // filter by severity
  const hi = await (await a.authed(`/alerts?severity=high`)).json();
  expect(hi.alerts.some((x: any) => x.id === id)).toBe(true);
  const lo = await (await a.authed(`/alerts?severity=low`)).json();
  expect(lo.alerts.some((x: any) => x.id === id)).toBe(false);
  // ack
  const ack = await a.authed(`/alerts/${id}/ack`, { method: "POST" });
  expect(ack.status).toBe(200);
  const acked = await (await a.authed(`/alerts?status=acked`)).json();
  expect(acked.alerts.some((x: any) => x.id === id)).toBe(true);
  // resolve
  const res = await a.authed(`/alerts/${id}/resolve`, { method: "POST" });
  expect(res.status).toBe(200);
  // another user cannot ack it
  const b = await user();
  const bad = await b.authed(`/alerts/${id}/ack`, { method: "POST" });
  expect(bad.status).toBe(404);
});
```

- [ ] **Step 3: Run to verify fail**

Run: `cd backend && DATABASE_URL=... bun test test/rules.test.ts` → new test FAILS (no severity filter, no ack route).

- [ ] **Step 4: Add filters + ack/resolve to alerts routes**

In `backend/src/alerts/routes.ts`:
1. In `GET /`, after the `to` handling, add severity/status conditions:

```ts
  const severity = c.req.query("severity");
  const status = c.req.query("status");
  if (severity) conds.push(eq(alerts.severity, severity));
  if (status) conds.push(eq(alerts.status, status));
```
2. Add the two endpoints (owner-scoped through the camera join). Append:

```ts
async function ownedAlert(userId: string, id: string) {
  if (!UUID_RE.test(id)) return null;
  const [row] = await db
    .select({ id: alerts.id })
    .from(alerts)
    .innerJoin(cameras, eq(alerts.cameraId, cameras.id))
    .where(and(eq(alerts.id, id), eq(cameras.userId, userId)))
    .limit(1);
  return row ?? null;
}

alertRoutes.post("/:id/ack", async (c) => {
  const owned = await ownedAlert(c.get("userId"), c.req.param("id"));
  if (!owned) return c.json({ error: "not found" }, 404);
  const [updated] = await db.update(alerts).set({ status: "acked", ackedAt: new Date() }).where(eq(alerts.id, owned.id)).returning();
  return c.json(updated);
});

alertRoutes.post("/:id/resolve", async (c) => {
  const owned = await ownedAlert(c.get("userId"), c.req.param("id"));
  if (!owned) return c.json({ error: "not found" }, 404);
  const [updated] = await db.update(alerts).set({ status: "resolved", resolvedAt: new Date() }).where(eq(alerts.id, owned.id)).returning();
  return c.json(updated);
});
```

- [ ] **Step 5: Run + commit**

Run: `cd backend && DATABASE_URL=... bun test` (whole suite) → all pass.

```bash
git add backend/src/realtime/ingest.ts backend/src/alerts/routes.ts backend/test/rules.test.ts
git commit -m "feat(api): persist alert label/rule/severity; severity+status filters; ack/resolve"
```

---

### Task 6: Multi-class detector

**Files:**
- Modify: `worker/app/detector.py` (`Box.label`, `detect_objects`, class map)
- Modify: `worker/app/config.py` (`MODEL_CLASSES`)
- Create: `worker/tests/test_detector_classes.py` (tests the pure class-map, not YOLO)

**Interfaces:**
- Produces: `Box(x, y, w, h, conf, label)`; `YoloDetector.detect_objects(frame) -> list[Box]`; module constant `COCO_NAMES: dict[int,str]` and `DEFAULT_CLASSES: list[str]`; helper `class_ids_for(names) -> list[int]`.

- [ ] **Step 1: Add config**

Append to `worker/app/config.py`:

```python
# rules engine (M2a)
import os as _os
MODEL_CLASSES = [
    s.strip() for s in _os.environ.get(
        "MODEL_CLASSES",
        "person,bicycle,car,motorcycle,bus,truck,cat,dog,backpack,handbag,suitcase",
    ).split(",") if s.strip()
]
TZ = _os.environ.get("TZ", "UTC")
```

- [ ] **Step 2: Write the failing test (pure class-map, no YOLO)**

Create `worker/tests/test_detector_classes.py`:

```python
import unittest

from app.detector import COCO_NAMES, class_ids_for, Box


class TestDetectorClasses(unittest.TestCase):
    def test_box_has_label(self):
        b = Box(0.1, 0.2, 0.3, 0.4, 0.9, "car")
        self.assertEqual(b.label, "car")

    def test_class_ids_for_maps_names_to_coco_ids(self):
        self.assertEqual(sorted(class_ids_for(["person", "car"])), [0, 2])

    def test_class_ids_for_skips_unknown(self):
        self.assertEqual(class_ids_for(["person", "dragon"]), [0])

    def test_coco_names_covers_curated_set(self):
        for name in ["person", "car", "truck", "dog", "backpack", "suitcase"]:
            self.assertIn(name, COCO_NAMES.values())


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 3: Run to verify fail**

Run: `cd worker && python3 -m unittest tests.test_detector_classes -v`
Expected: FAIL — `COCO_NAMES`/`class_ids_for` not defined.

- [ ] **Step 4: Implement multi-class detection**

Replace `worker/app/detector.py` with:

```python
from abc import ABC, abstractmethod
from dataclasses import dataclass

# COCO id -> name, curated to the surveillance-relevant subset.
COCO_NAMES = {
    0: "person", 1: "bicycle", 2: "car", 3: "motorcycle", 5: "bus",
    7: "truck", 15: "cat", 16: "dog", 24: "backpack", 26: "handbag", 28: "suitcase",
}
_NAME_TO_ID = {v: k for k, v in COCO_NAMES.items()}
DEFAULT_CLASSES = list(COCO_NAMES.values())


def class_ids_for(names) -> list[int]:
    """COCO ids for the given class names, skipping unknown names."""
    return [_NAME_TO_ID[n] for n in names if n in _NAME_TO_ID]


@dataclass
class Box:
    """A detected object box, normalized to [0, 1] with origin top-left."""

    x: float
    y: float
    w: float
    h: float
    conf: float
    label: str


class Detector(ABC):
    @abstractmethod
    def detect_objects(self, frame_bgr) -> list[Box]:
        ...


class YoloDetector(Detector):
    def __init__(self, model_path: str, conf: float, classes=None):
        from ultralytics import YOLO

        self.model = YOLO(model_path)
        self.conf = conf
        self.class_ids = class_ids_for(classes or DEFAULT_CLASSES)

    def detect_objects(self, frame_bgr) -> list[Box]:
        h, w = frame_bgr.shape[:2]
        results = self.model.predict(
            frame_bgr, conf=self.conf, classes=self.class_ids, verbose=False
        )
        boxes: list[Box] = []
        for r in results:
            for b in r.boxes:
                x1, y1, x2, y2 = b.xyxy[0].tolist()
                cls_id = int(b.cls[0])
                boxes.append(
                    Box(
                        x=x1 / w,
                        y=y1 / h,
                        w=(x2 - x1) / w,
                        h=(y2 - y1) / h,
                        conf=round(float(b.conf[0]), 4),
                        label=COCO_NAMES.get(cls_id, str(cls_id)),
                    )
                )
        return boxes
```

- [ ] **Step 5: Run to verify pass**

Run: `cd worker && python3 -m unittest tests.test_detector_classes -v`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add worker/app/detector.py worker/app/config.py worker/tests/test_detector_classes.py
git commit -m "feat(worker): multi-class detection (detect_objects + COCO class map)"
```

---

### Task 7: Rules evaluation engine (`rules.py`) — pure, TDD

**Files:**
- Create: `worker/app/rules.py`
- Create: `worker/tests/test_rules.py`

**Interfaces:**
- Consumes: `Box` (Task 6, duck-typed: needs `.x .y .w .h .conf .label`).
- Produces: `point_in_polygon(px, py, polygon) -> bool`; `schedule_active(start, end, now_hhmm) -> bool`; `evaluate(objects, rules, now_hhmm, default_conf) -> list[Match]`; `Match(rule_id, severity, label, boxes, count, confidence)`.

- [ ] **Step 1: Write the failing tests**

Create `worker/tests/test_rules.py`:

```python
import unittest

from app.rules import point_in_polygon, schedule_active, evaluate, Match


class Obj:
    def __init__(self, x, y, w, h, conf, label):
        self.x, self.y, self.w, self.h, self.conf, self.label = x, y, w, h, conf, label


SQUARE = [{"x": 0.0, "y": 0.0}, {"x": 1.0, "y": 0.0}, {"x": 1.0, "y": 1.0}, {"x": 0.0, "y": 1.0}]


class TestGeometry(unittest.TestCase):
    def test_point_inside(self):
        self.assertTrue(point_in_polygon(0.5, 0.5, SQUARE))

    def test_point_outside(self):
        self.assertFalse(point_in_polygon(1.5, 0.5, SQUARE))

    def test_triangle(self):
        tri = [{"x": 0.0, "y": 0.0}, {"x": 1.0, "y": 0.0}, {"x": 0.0, "y": 1.0}]
        self.assertTrue(point_in_polygon(0.2, 0.2, tri))
        self.assertFalse(point_in_polygon(0.8, 0.8, tri))


class TestSchedule(unittest.TestCase):
    def test_always_when_none(self):
        self.assertTrue(schedule_active(None, None, "03:00"))

    def test_normal_window(self):
        self.assertTrue(schedule_active("08:00", "17:00", "12:00"))
        self.assertFalse(schedule_active("08:00", "17:00", "20:00"))

    def test_wraparound_window(self):
        self.assertTrue(schedule_active("22:00", "06:00", "23:30"))
        self.assertTrue(schedule_active("22:00", "06:00", "02:00"))
        self.assertFalse(schedule_active("22:00", "06:00", "12:00"))


class TestEvaluate(unittest.TestCase):
    def test_implicit_default_alerts_on_person(self):
        objs = [Obj(0.1, 0.1, 0.1, 0.1, 0.9, "person"), Obj(0.5, 0.5, 0.1, 0.1, 0.9, "car")]
        matches = evaluate(objs, [], "12:00", 0.4)
        self.assertEqual(len(matches), 1)
        self.assertIsNone(matches[0].rule_id)
        self.assertEqual(matches[0].severity, "low")
        self.assertEqual(matches[0].count, 1)  # person only

    def test_class_and_conf_filter(self):
        rule = {"id": "r1", "classes": ["car"], "zone": None, "schedule": [None, None], "min_confidence": 0.5, "severity": "high", "enabled": True}
        objs = [Obj(0.5, 0.5, 0.1, 0.1, 0.9, "car"), Obj(0.5, 0.5, 0.1, 0.1, 0.3, "car"), Obj(0.5, 0.5, 0.1, 0.1, 0.9, "person")]
        matches = evaluate(objs, [rule], "12:00", 0.4)
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0].count, 1)  # only the 0.9 car
        self.assertEqual(matches[0].rule_id, "r1")

    def test_zone_containment_uses_bottom_center(self):
        # bottom-center of the box = (x+w/2, y+h) = (0.5, 0.6) -> inside top-left quadrant
        quad = [{"x": 0.0, "y": 0.0}, {"x": 0.6, "y": 0.0}, {"x": 0.6, "y": 0.7}, {"x": 0.0, "y": 0.7}]
        rule = {"id": "r1", "classes": ["person"], "zone": quad, "schedule": [None, None], "min_confidence": 0.4, "severity": "low", "enabled": True}
        inside = [Obj(0.4, 0.5, 0.2, 0.1, 0.9, "person")]   # bottom-center (0.5, 0.6) inside
        outside = [Obj(0.7, 0.7, 0.2, 0.1, 0.9, "person")]  # bottom-center (0.8, 0.8) outside
        self.assertEqual(len(evaluate(inside, [rule], "12:00", 0.4)), 1)
        self.assertEqual(len(evaluate(outside, [rule], "12:00", 0.4)), 0)

    def test_schedule_gates_the_rule(self):
        rule = {"id": "r1", "classes": ["person"], "zone": None, "schedule": ["22:00", "06:00"], "min_confidence": 0.4, "severity": "high", "enabled": True}
        objs = [Obj(0.5, 0.5, 0.1, 0.1, 0.9, "person")]
        self.assertEqual(len(evaluate(objs, [rule], "23:00", 0.4)), 1)
        self.assertEqual(len(evaluate(objs, [rule], "12:00", 0.4)), 0)

    def test_disabled_rule_skipped(self):
        rule = {"id": "r1", "classes": ["person"], "zone": None, "schedule": [None, None], "min_confidence": 0.4, "severity": "low", "enabled": False}
        objs = [Obj(0.5, 0.5, 0.1, 0.1, 0.9, "person")]
        # no enabled rules -> falls back to implicit default (person, low)
        matches = evaluate(objs, [rule], "12:00", 0.4)
        self.assertEqual(len(matches), 1)
        self.assertIsNone(matches[0].rule_id)

    def test_multiple_rules_multiple_matches(self):
        r1 = {"id": "r1", "classes": ["person"], "zone": None, "schedule": [None, None], "min_confidence": 0.4, "severity": "low", "enabled": True}
        r2 = {"id": "r2", "classes": ["car"], "zone": None, "schedule": [None, None], "min_confidence": 0.4, "severity": "high", "enabled": True}
        objs = [Obj(0.1, 0.1, 0.1, 0.1, 0.9, "person"), Obj(0.5, 0.5, 0.1, 0.1, 0.9, "car")]
        matches = evaluate(objs, [r1, r2], "12:00", 0.4)
        self.assertEqual({m.rule_id for m in matches}, {"r1", "r2"})


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to verify fail**

Run: `cd worker && python3 -m unittest tests.test_rules -v`
Expected: FAIL — `No module named 'app.rules'`.

- [ ] **Step 3: Implement `rules.py`**

Create `worker/app/rules.py`:

```python
from dataclasses import dataclass


@dataclass
class Match:
    rule_id: str | None
    severity: str
    label: str
    boxes: list
    count: int
    confidence: float


def point_in_polygon(px: float, py: float, polygon) -> bool:
    """Ray-casting test. `polygon` is a list of {"x","y"} (normalized)."""
    n = len(polygon)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i]["x"], polygon[i]["y"]
        xj, yj = polygon[j]["x"], polygon[j]["y"]
        if ((yi > py) != (yj > py)) and (
            px < (xj - xi) * (py - yi) / ((yj - yi) or 1e-12) + xi
        ):
            inside = not inside
        j = i
    return inside


def schedule_active(start, end, now_hhmm: str) -> bool:
    """True if now (``"HH:MM"``) is within [start, end). None/None = always.
    Wrap-around (start > end, e.g. 22:00->06:00) supported. Zero-padded 24h
    strings compare correctly lexicographically."""
    if not start or not end:
        return True
    if start <= end:
        return start <= now_hhmm < end
    return now_hhmm >= start or now_hhmm < end


_DEFAULT_RULE = {
    "id": None, "classes": ["person"], "zone": None,
    "schedule": [None, None], "min_confidence": None, "severity": "low",
    "enabled": True,
}


def evaluate(objects, rules, now_hhmm: str, default_conf: float) -> list[Match]:
    """One Match per rule that has >=1 surviving object. If no rules are enabled,
    a synthesized 'any person, low' default is used (implicit-default behavior)."""
    active = [r for r in rules if r.get("enabled", True)]
    if not active:
        active = [dict(_DEFAULT_RULE, min_confidence=default_conf)]

    matches: list[Match] = []
    for rule in active:
        start, end = rule.get("schedule", [None, None])
        if not schedule_active(start, end, now_hhmm):
            continue
        min_conf = rule.get("min_confidence")
        if min_conf is None:
            min_conf = default_conf
        classes = rule["classes"]
        zone = rule.get("zone")
        selected = []
        for o in objects:
            if o.label not in classes or o.conf < min_conf:
                continue
            if zone is not None and not point_in_polygon(o.x + o.w / 2, o.y + o.h, zone):
                continue
            selected.append(o)
        if not selected:
            continue
        top = max(selected, key=lambda o: o.conf)
        matches.append(
            Match(
                rule_id=rule["id"],
                severity=rule["severity"],
                label=top.label,
                boxes=selected,
                count=len(selected),
                confidence=top.conf,
            )
        )
    return matches
```

- [ ] **Step 4: Run to verify pass**

Run: `cd worker && python3 -m unittest tests.test_rules -v`
Expected: PASS (all geometry/schedule/evaluate tests).

- [ ] **Step 5: Commit**

```bash
git add worker/app/rules.py worker/tests/test_rules.py
git commit -m "feat(worker): rules evaluation engine (zone + class + schedule)"
```

---

### Task 8: Per-(camera,rule) dedup key

**Files:**
- Modify: `worker/app/dedup.py` (generalize key; prefix reset)
- Modify: `worker/tests/test_dedup.py` (add composite-key tests)

**Interfaces:**
- Produces: `DedupRateLimiter.should_emit(key, count, now_ms)` (param renamed `camera_id`→`key`); `reset(camera_id)` clears all keys prefixed `"{camera_id}:"` and the bare `camera_id`.

- [ ] **Step 1: Write the failing tests**

Add to `worker/tests/test_dedup.py`:

```python
    def test_composite_keys_are_independent(self):
        lim = DedupRateLimiter(3000, 30)
        self.assertTrue(lim.should_emit("cam:r1", 1, 1000))
        self.assertTrue(lim.should_emit("cam:r2", 1, 1000))  # different rule, not suppressed
        self.assertFalse(lim.should_emit("cam:r1", 1, 1100))  # same rule suppressed

    def test_reset_clears_all_rule_keys_for_a_camera(self):
        lim = DedupRateLimiter(3000, 30)
        self.assertTrue(lim.should_emit("cam:r1", 1, 1000))
        self.assertTrue(lim.should_emit("cam:r2", 1, 1000))
        lim.reset("cam")
        self.assertTrue(lim.should_emit("cam:r1", 1, 1100))  # reset cleared it
        self.assertTrue(lim.should_emit("cam:r2", 1, 1100))
```

- [ ] **Step 2: Run to verify fail**

Run: `cd worker && python3 -m unittest tests.test_dedup -v`
Expected: FAIL — `reset("cam")` doesn't clear `"cam:r1"` (current reset pops exact key only).

- [ ] **Step 3: Update `dedup.py`**

In `worker/app/dedup.py`, rename the `should_emit` first param and update `reset`:

```python
    def should_emit(self, key: str, count: int, now_ms: float) -> bool:
        if count <= 0:
            return False

        st = self._cams.get(key)
        if st is None:
            st = _CamState()
            self._cams[key] = st
        # ... rest unchanged (all `self._cams[...]` already keyed by `key`) ...
```
(Replace every `camera_id` inside `should_emit` with `key`.) Then:

```python
    def reset(self, camera_id: str) -> None:
        for k in [k for k in self._cams if k == camera_id or k.startswith(camera_id + ":")]:
            self._cams.pop(k, None)
```

- [ ] **Step 4: Run to verify pass**

Run: `cd worker && python3 -m unittest tests.test_dedup -v`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add worker/app/dedup.py worker/tests/test_dedup.py
git commit -m "feat(worker): per-(camera,rule) dedup key + prefix reset"
```

---

### Task 9: Detection event carries label/rule/severity

**Files:**
- Modify: `worker/app/events.py` (`detection_event` new params)
- Modify: `docs/EVENT_FORMAT.md` (§2 + start/rules_update commands)
- Modify: `worker/tests/test_events.py` (assert new fields)

**Interfaces:**
- Produces: `detection_event(camera_id, confidence, count, bboxes, frame_w, frame_h, worker_id, label=None, rule_id=None, severity="low", ts=None)` returning `type: "detection"` plus `label`/`rule_id`/`severity`.

- [ ] **Step 1: Write the failing test**

Add to `worker/tests/test_events.py`:

```python
    def test_detection_event_carries_label_rule_severity(self):
        from app.events import detection_event
        e = detection_event("cam", 0.9, 1, [{"x": 0, "y": 0, "w": 0.1, "h": 0.1, "conf": 0.9, "label": "car"}], 1280, 720, "w1", label="car", rule_id="r1", severity="high")
        self.assertEqual(e["type"], "detection")
        self.assertEqual(e["label"], "car")
        self.assertEqual(e["rule_id"], "r1")
        self.assertEqual(e["severity"], "high")
```

- [ ] **Step 2: Run to verify fail**

Run: `cd worker && python3 -m unittest tests.test_events -v`
Expected: FAIL — `detection_event` has no `label` kwarg.

- [ ] **Step 3: Update `detection_event`**

In `worker/app/events.py`, replace `detection_event` with:

```python
def detection_event(
    camera_id: str,
    confidence: float,
    count: int,
    bboxes: list[dict],
    frame_w: int,
    frame_h: int,
    worker_id: str,
    label: str | None = None,
    rule_id: str | None = None,
    severity: str = "low",
    ts: str | None = None,
) -> dict:
    """Detection event — matches §2 of docs/EVENT_FORMAT.md."""
    return {
        "id": str(uuid.uuid4()),
        "type": "detection",
        "camera_id": camera_id,
        "ts": ts or now_iso(),
        "label": label,
        "rule_id": rule_id,
        "severity": severity,
        "confidence": round(float(confidence), 4),
        "count": int(count),
        "bboxes": bboxes,
        "frame_w": frame_w,
        "frame_h": frame_h,
        "worker_id": worker_id,
    }
```

- [ ] **Step 4: Update EVENT_FORMAT.md**

In `docs/EVENT_FORMAT.md`: update §1 (camera command) to note `start` now carries a `rules` array and add a `rules_update` command; update §2 (detection event) to add `label`, `rule_id`, `severity`, and per-box `label`, and note `type` is now `"detection"`. Match the shapes in Task 9 Step 3 and Task 4 Step 1.

- [ ] **Step 5: Run to verify pass**

Run: `cd worker && python3 -m unittest tests.test_events -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add worker/app/events.py worker/tests/test_events.py docs/EVENT_FORMAT.md
git commit -m "feat(worker): detection event carries label/rule_id/severity"
```

---

### Task 10: Wire rules into the camera pipeline + `rules_update`

**Files:**
- Modify: `worker/app/camera_worker.py` (rules field, `set_rules`, multi-class detect + evaluate + per-match emit, annotate labels)
- Modify: `worker/app/main.py` (pass rules on start; handle `rules_update`; build detector with `MODEL_CLASSES`)

**Interfaces:**
- Consumes: `evaluate`/`Match` (Task 7), `detect_objects` (Task 6), composite dedup key (Task 8), `detection_event` (Task 9), `CONF_THRESHOLD`/`TZ`/`MODEL_CLASSES` config.
- Produces: `CameraWorker(camera_id, rtsp_url, detector, publish, limiter, rules)`; `CameraWorker.set_rules(rules)`.

- [ ] **Step 1: `CameraWorker.__init__` takes rules; add `set_rules` + local-time helper**

In `worker/app/camera_worker.py`:
1. Extend imports:
```python
from .config import (
    DETECT_EVERY_N, WORKER_ID, PRE_ROLL_S, POST_ROLL_S, MAX_CLIP_LEN_S,
    RECORDINGS_DIR, STORAGE_BACKEND, CONF_THRESHOLD, TZ,
)
from .rules import evaluate as evaluate_rules
```
2. Change the constructor signature to `def __init__(self, camera_id, rtsp_url, detector, publish, limiter, rules=None):` and add `self.rules = rules or []` near the other fields.
3. Add the method + helper (near `new_track`):
```python
    def set_rules(self, rules) -> None:
        self.rules = rules or []

    def _now_hhmm(self) -> str:
        from datetime import datetime
        from zoneinfo import ZoneInfo
        try:
            tz = ZoneInfo(TZ)
        except Exception:
            tz = ZoneInfo("UTC")
        return datetime.now(tz).strftime("%H:%M")
```

- [ ] **Step 2: Multi-class detect + rule eval in the decode loop**

In `_decode_loop`, replace the detection block:
```python
                    boxes = []
                    if frame_count % DETECT_EVERY_N == 0:
                        boxes = self.detector.detect_persons(img)

                    annotated = self._annotate(img, boxes)
                    if boxes:
                        self._maybe_emit_detection(img, boxes, now, annotated)
```
with:
```python
                    boxes = []
                    if frame_count % DETECT_EVERY_N == 0:
                        boxes = self.detector.detect_objects(img)

                    annotated = self._annotate(img, boxes)
                    if boxes:
                        self._emit_matches(img, boxes, now, annotated)
```

- [ ] **Step 3: Replace `_maybe_emit_detection` with `_emit_matches`**

```python
    def _emit_matches(self, img, boxes, now_ms: float, annotated) -> None:
        matches = evaluate_rules(boxes, self.rules, self._now_hhmm(), CONF_THRESHOLD)
        if not matches:
            return
        self._det_times.append(now_ms)
        h, w = img.shape[:2]
        first_emitted_id = None
        for m in matches:
            key = f"{self.camera_id}:{m.rule_id or ''}"
            if not self.limiter.should_emit(key, m.count, now_ms):
                continue
            payload = detection_event(
                self.camera_id,
                m.confidence,
                m.count,
                [
                    {"x": round(b.x, 4), "y": round(b.y, 4), "w": round(b.w, 4),
                     "h": round(b.h, 4), "conf": b.conf, "label": b.label}
                    for b in m.boxes
                ],
                w, h, WORKER_ID,
                label=m.label, rule_id=m.rule_id, severity=m.severity,
            )
            self._evq.put(("detections", payload))
            if first_emitted_id is None:
                first_emitted_id = payload["id"]
        # one clip per frame-worth-of-matches, linked to the first emitted alert
        if first_emitted_id is not None:
            self.recorder.trigger(annotated, first_emitted_id)
```

- [ ] **Step 4: Annotate with the object label**

In `_annotate`, change the label text from the hard-coded `"person"` to the box's label:
```python
            cv2.putText(
                img,
                f"{b.label} {b.conf:.2f}",
                (x1, max(0, y1 - 6)),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1,
            )
```

- [ ] **Step 5: `main.py` — build detector with classes, pass rules, handle `rules_update`**

In `worker/app/main.py`:
1. Import config classes: `from .config import (CONF_THRESHOLD, DEDUP_WINDOW_MS, MAX_EVENTS_PER_MIN, MODEL_PATH, MODEL_CLASSES, REDIS_URL)` and build `self.detector = YoloDetector(MODEL_PATH, CONF_THRESHOLD, MODEL_CLASSES)`.
2. In `handle_command`, pass rules on start and handle updates:
```python
        if kind == "start":
            if cid in self.workers:
                return
            worker = CameraWorker(
                cid, cmd["rtsp_url"], self.detector, self.publish, self.limiter,
                cmd.get("rules", []),
            )
            self.workers[cid] = worker
            worker.start()
            log.info("started camera %s (%d rules)", cid, len(cmd.get("rules", [])))
        elif kind == "rules_update":
            worker = self.workers.get(cid)
            if worker:
                worker.set_rules(cmd.get("rules", []))
                log.info("updated rules for camera %s (%d)", cid, len(cmd.get("rules", [])))
        elif kind == "stop":
            worker = self.workers.pop(cid, None)
            if worker:
                await worker.stop()
                self.limiter.reset(cid)
                log.info("stopped camera %s", cid)
```

- [ ] **Step 6: Verify (deps absent on host — py_compile + pure suite)**

The worker's heavy deps (av/aiortc/cv2/torch) are Docker-only, so DO NOT import `camera_worker`/`main` here.
Run: `cd worker && python3 -m py_compile app/camera_worker.py app/main.py && echo OK`
Run: `cd worker && python3 -m unittest discover -s tests -v` → all pure tests pass (detector-classes, rules, dedup, events, recorder).
Real end-to-end is Task 15 (docker compose).

- [ ] **Step 7: Commit**

```bash
git add worker/app/camera_worker.py worker/app/main.py
git commit -m "feat(worker): evaluate rules per frame, emit per-match alerts, live rules_update"
```

---

### Task 11: Frontend types + API client

**Files:**
- Modify: `frontend/lib/types.ts` (Zone, Rule; extend Alert)
- Modify: `frontend/lib/api.ts` (zones/rules CRUD + ack/resolve + alert filters)
- Create: `frontend/lib/geometry.ts` + `frontend/lib/geometry.test.ts` (polygon normalize helper)

**Interfaces:**
- Produces: `Zone`, `Rule`, `Severity` types; `Alert` gains `label?/ruleId?/severity?/status?`; `api.listZones/createZone/deleteZone`, `api.listRules/createRule/updateRule/deleteRule`, `api.ackAlert/resolveAlert`, `api.listAlerts(...)` gains filters; `toNormalized(points, w, h)` / `toPixels(polygon, w, h)`.

- [ ] **Step 1: Add types**

In `frontend/lib/types.ts` add `clipId`-style fields to `Alert` and new types:

```ts
export type Severity = "low" | "medium" | "high";
export type AlertStatus = "new" | "acked" | "resolved";

// extend the existing Alert type with:
//   label?: string | null; ruleId?: string | null;
//   severity?: Severity; status?: AlertStatus;

export type Zone = {
  id: string;
  cameraId: string;
  name: string;
  polygon: { x: number; y: number }[];
  createdAt: string;
};

export type Rule = {
  id: string;
  cameraId: string;
  name: string;
  zoneId: string | null;
  classes: string[];
  scheduleStart: string | null;
  scheduleEnd: string | null;
  minConfidence: number;
  severity: Severity;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};
```
(Manually add the four commented fields into the existing `Alert` type object.)

- [ ] **Step 2: Add API calls**

In `frontend/lib/api.ts`, add to the `api` object:

```ts
  listAlerts: (params: { cameraId?: string; severity?: string; status?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.cameraId) q.set("camera_id", params.cameraId);
    if (params.severity) q.set("severity", params.severity);
    if (params.status) q.set("status", params.status);
    q.set("limit", String(params.limit ?? 20));
    return req(`/alerts?${q.toString()}`);
  },
  ackAlert: (id: string) => req(`/alerts/${id}/ack`, { method: "POST" }),
  resolveAlert: (id: string) => req(`/alerts/${id}/resolve`, { method: "POST" }),

  listZones: (cameraId: string) => req(`/cameras/${cameraId}/zones`),
  createZone: (cameraId: string, body: Record<string, unknown>) => req(`/cameras/${cameraId}/zones`, { method: "POST", body: JSON.stringify(body) }),
  deleteZone: (cameraId: string, zoneId: string) => req(`/cameras/${cameraId}/zones/${zoneId}`, { method: "DELETE" }),

  listRules: (cameraId: string) => req(`/cameras/${cameraId}/rules`),
  createRule: (cameraId: string, body: Record<string, unknown>) => req(`/cameras/${cameraId}/rules`, { method: "POST", body: JSON.stringify(body) }),
  updateRule: (cameraId: string, ruleId: string, body: Record<string, unknown>) => req(`/cameras/${cameraId}/rules/${ruleId}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteRule: (cameraId: string, ruleId: string) => req(`/cameras/${cameraId}/rules/${ruleId}`, { method: "DELETE" }),
```

**Note:** the existing `listAlerts(cameraId?, limit)` signature changes to an options object. Update its two current callers — `frontend/app/dashboard/page.tsx` (`api.listAlerts(c.id, 5)` → `api.listAlerts({ cameraId: c.id, limit: 5 })`) — in this task so the build stays green.

- [ ] **Step 3: Geometry helper (TDD)**

Create `frontend/lib/geometry.test.ts`:

```ts
import { test, expect } from "bun:test";
import { toNormalized, toPixels } from "./geometry";

test("toNormalized divides by canvas size", () => {
  expect(toNormalized([{ x: 128, y: 72 }], 1280, 720)).toEqual([{ x: 0.1, y: 0.1 }]);
});
test("toPixels multiplies by canvas size", () => {
  expect(toPixels([{ x: 0.1, y: 0.1 }], 1280, 720)).toEqual([{ x: 128, y: 72 }]);
});
test("round-trips", () => {
  const px = [{ x: 640, y: 360 }];
  const back = toPixels(toNormalized(px, 1280, 720), 1280, 720);
  expect(back[0].x).toBeCloseTo(640);
  expect(back[0].y).toBeCloseTo(360);
});
```

Create `frontend/lib/geometry.ts`:

```ts
export type Pt = { x: number; y: number };
export const toNormalized = (pts: Pt[], w: number, h: number): Pt[] =>
  pts.map((p) => ({ x: p.x / w, y: p.y / h }));
export const toPixels = (poly: Pt[], w: number, h: number): Pt[] =>
  poly.map((p) => ({ x: p.x * w, y: p.y * h }));
```

- [ ] **Step 4: Test + build**

Run: `cd frontend && bunx bun test lib/geometry.test.ts` (or `npx vitest run` if configured; if no test runner, skip and rely on build). Then `cd frontend && npm run build` → compiles.

- [ ] **Step 5: Commit**

```bash
git add frontend/lib/types.ts frontend/lib/api.ts frontend/lib/geometry.ts frontend/lib/geometry.test.ts frontend/app/dashboard/page.tsx
git commit -m "feat(web): zone/rule types + api client + alert filters/ack + geometry helper"
```

---

### Task 12: Zone editor (draw polygon on the live video)

**Files:**
- Create: `frontend/components/ZoneEditor.tsx`
- Modify: `frontend/components/CameraTile.tsx` (a "Zones" button that opens it; pass the `<video>` ref)
- Modify: `frontend/app/globals.css` (editor styles)

**Interfaces:**
- Consumes: `api.listZones/createZone/deleteZone`, `toNormalized`, `toPixels`, the tile's live `<video>` element.
- Produces: `ZoneEditor({ camera, videoEl, onClose })`.

- [ ] **Step 1: Build the editor component**

Create `frontend/components/ZoneEditor.tsx`:

```tsx
"use client";
import { useEffect, useRef, useState } from "react";
import type { Camera, Zone } from "@/lib/types";
import { api } from "@/lib/api";
import { toNormalized, toPixels, type Pt } from "@/lib/geometry";

const W = 640, H = 360;

export function ZoneEditor({ camera, videoEl, onClose }: { camera: Camera; videoEl: HTMLVideoElement | null; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zones, setZones] = useState<Zone[]>([]);
  const [points, setPoints] = useState<Pt[]>([]);
  const [name, setName] = useState("Zone");
  const [snapshot, setSnapshot] = useState<ImageData | null>(null);
  const live = !!videoEl && videoEl.videoWidth > 0;

  useEffect(() => { api.listZones(camera.id).then(setZones).catch(() => {}); }, [camera.id]);

  // grab one still frame from the live video
  useEffect(() => {
    if (!videoEl || !live) return;
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(videoEl, 0, 0, W, H);
    setSnapshot(ctx.getImageData(0, 0, W, H));
  }, [videoEl, live]);

  // redraw snapshot + existing zones + in-progress polygon
  useEffect(() => {
    const c = canvasRef.current; if (!c) return;
    const ctx = c.getContext("2d")!;
    if (snapshot) ctx.putImageData(snapshot, 0, 0);
    else { ctx.fillStyle = "#222"; ctx.fillRect(0, 0, W, H); }
    for (const z of zones) drawPoly(ctx, toPixels(z.polygon as Pt[], W, H), "rgba(0,180,255,0.6)");
    if (points.length) drawPoly(ctx, points, "rgba(0,255,0,0.9)", true);
  }, [snapshot, zones, points]);

  function drawPoly(ctx: CanvasRenderingContext2D, pts: Pt[], color: string, open = false) {
    if (!pts.length) return;
    ctx.strokeStyle = color; ctx.fillStyle = color.replace(/[\d.]+\)$/, "0.15)"); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    pts.forEach((p) => ctx.lineTo(p.x, p.y));
    if (!open) ctx.closePath();
    ctx.stroke(); if (!open) ctx.fill();
    pts.forEach((p) => { ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, 7); ctx.fill(); });
  }

  function addPoint(e: React.MouseEvent) {
    const r = canvasRef.current!.getBoundingClientRect();
    setPoints((p) => [...p, { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H }]);
  }

  async function save() {
    if (points.length < 3) return;
    await api.createZone(camera.id, { name: name.trim() || "Zone", polygon: toNormalized(points, W, H) });
    setPoints([]); setZones(await api.listZones(camera.id));
  }
  async function del(id: string) { await api.deleteZone(camera.id, id); setZones(await api.listZones(camera.id)); }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="clip-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Zones — {camera.name}</h3>
        {!live && <p className="muted small">Start the camera to draw zones on the live view.</p>}
        <canvas ref={canvasRef} width={W} height={H} onClick={addPoint} style={{ width: "100%", cursor: "crosshair", background: "#111" }} />
        <div className="modal-actions">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Zone name" />
          <button onClick={() => setPoints([])}>Clear</button>
          <button className="primary" onClick={save} disabled={points.length < 3}>Save zone ({points.length})</button>
          <button onClick={onClose}>Close</button>
        </div>
        <div className="zone-list">
          {zones.map((z) => (
            <div key={z.id} className="zone-row"><span>{z.name}</span><button className="danger" onClick={() => del(z.id)}>Delete</button></div>
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire a "Zones" button into the tile**

In `frontend/components/CameraTile.tsx`: import `ZoneEditor`, add `const [showZones, setShowZones] = useState(false);`, add a `<button onClick={() => setShowZones(true)}>Zones</button>` in `.tile-actions`, and render `{showZones && <ZoneEditor camera={camera} videoEl={videoRef.current} onClose={() => setShowZones(false)} />}` before the closing `</div>`. (`videoRef` already exists in the tile.)

- [ ] **Step 3: Styles + build**

Append to `frontend/app/globals.css`:
```css
.zone-list { margin-top: 8px; max-height: 120px; overflow-y: auto; }
.zone-row { display: flex; justify-content: space-between; align-items: center; padding: 4px 0; }
```
Run: `cd frontend && npm run build` → compiles.

- [ ] **Step 4: Commit**

```bash
git add frontend/components/ZoneEditor.tsx frontend/components/CameraTile.tsx frontend/app/globals.css
git commit -m "feat(web): zone editor — draw polygons on the live camera view"
```

---

### Task 13: Rules panel (list + add/edit)

**Files:**
- Create: `frontend/components/RulesPanel.tsx`
- Modify: `frontend/components/CameraTile.tsx` (a "Rules" button)

**Interfaces:**
- Consumes: `api.listRules/createRule/updateRule/deleteRule`, `api.listZones`.
- Produces: `RulesPanel({ camera, onClose })`.

- [ ] **Step 1: Build the panel**

Create `frontend/components/RulesPanel.tsx`:

```tsx
"use client";
import { useEffect, useState } from "react";
import type { Camera, Rule, Zone } from "@/lib/types";
import { api } from "@/lib/api";

const CLASSES = ["person", "bicycle", "car", "motorcycle", "bus", "truck", "cat", "dog", "backpack", "handbag", "suitcase"];
const empty = { name: "", classes: ["person"] as string[], zoneId: "", scheduleStart: "", scheduleEnd: "", minConfidence: 0.4, severity: "low", enabled: true };

export function RulesPanel({ camera, onClose }: { camera: Camera; onClose: () => void }) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [form, setForm] = useState<any>(empty);
  const [err, setErr] = useState<string | null>(null);

  const load = () => { api.listRules(camera.id).then(setRules).catch(() => {}); };
  useEffect(() => { load(); api.listZones(camera.id).then(setZones).catch(() => {}); }, [camera.id]);

  async function save() {
    setErr(null);
    try {
      await api.createRule(camera.id, {
        name: form.name, classes: form.classes,
        zoneId: form.zoneId || undefined,
        scheduleStart: form.scheduleStart || null, scheduleEnd: form.scheduleEnd || null,
        minConfidence: Number(form.minConfidence), severity: form.severity, enabled: form.enabled,
      });
      setForm(empty); load();
    } catch (e: any) { setErr(e.message); }
  }
  async function toggle(r: Rule) { await api.updateRule(camera.id, r.id, { enabled: !r.enabled }); load(); }
  async function del(r: Rule) { await api.deleteRule(camera.id, r.id); load(); }
  function toggleClass(cl: string) { setForm((f: any) => ({ ...f, classes: f.classes.includes(cl) ? f.classes.filter((x: string) => x !== cl) : [...f.classes, cl] })); }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="clip-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Rules — {camera.name}</h3>
        <div className="rules-list">
          {rules.length === 0 && <p className="muted small">No rules — this camera alerts on any person (default).</p>}
          {rules.map((r) => (
            <div key={r.id} className="rule-row">
              <span className={`badge ${r.severity}`}>{r.severity}</span>
              <strong>{r.name}</strong>
              <span className="muted small">{(r.classes as string[]).join(", ")}{r.zoneId ? " · zoned" : ""}{r.scheduleStart ? ` · ${r.scheduleStart}–${r.scheduleEnd}` : ""}</span>
              <button onClick={() => toggle(r)}>{r.enabled ? "Disable" : "Enable"}</button>
              <button className="danger" onClick={() => del(r)}>Delete</button>
            </div>
          ))}
        </div>
        <hr />
        <div className="rule-form">
          <input placeholder="Rule name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <div className="class-chips">
            {CLASSES.map((cl) => (
              <button key={cl} className={form.classes.includes(cl) ? "chip on" : "chip"} onClick={() => toggleClass(cl)}>{cl}</button>
            ))}
          </div>
          <select value={form.zoneId} onChange={(e) => setForm({ ...form, zoneId: e.target.value })}>
            <option value="">Whole frame</option>
            {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
          </select>
          <label>From <input type="time" value={form.scheduleStart} onChange={(e) => setForm({ ...form, scheduleStart: e.target.value })} /></label>
          <label>To <input type="time" value={form.scheduleEnd} onChange={(e) => setForm({ ...form, scheduleEnd: e.target.value })} /></label>
          <label>Min conf <input type="number" min="0" max="1" step="0.05" value={form.minConfidence} onChange={(e) => setForm({ ...form, minConfidence: e.target.value })} /></label>
          <select value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })}>
            <option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
          </select>
          {err && <p className="error">{err}</p>}
          <button className="primary" onClick={save} disabled={!form.name || form.classes.length === 0}>Add rule</button>
        </div>
        <div className="modal-actions"><button onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire a "Rules" button into the tile**

In `frontend/components/CameraTile.tsx`: import `RulesPanel`, add `const [showRules, setShowRules] = useState(false);`, a `<button onClick={() => setShowRules(true)}>Rules</button>` in `.tile-actions`, and `{showRules && <RulesPanel camera={camera} onClose={() => setShowRules(false)} />}`.

- [ ] **Step 3: Styles + build**

Append to `frontend/app/globals.css`:
```css
.class-chips { display: flex; flex-wrap: wrap; gap: 4px; margin: 6px 0; }
.chip { padding: 2px 8px; border: 1px solid #444; border-radius: 12px; background: transparent; cursor: pointer; font-size: 12px; }
.chip.on { background: #2563eb; border-color: #2563eb; color: #fff; }
.rule-row, .rule-form { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 4px 0; }
.badge.low { background: #3b82f6; } .badge.medium { background: #f59e0b; } .badge.high { background: #ef4444; }
```
Run: `cd frontend && npm run build` → compiles.

- [ ] **Step 4: Commit**

```bash
git add frontend/components/RulesPanel.tsx frontend/components/CameraTile.tsx frontend/app/globals.css
git commit -m "feat(web): rules panel — per-camera rule list + add/edit form"
```

---

### Task 14: Alert display — severity, label, rule, ack/resolve

**Files:**
- Modify: `frontend/components/CameraTile.tsx` (alert rows show severity + label + ack/resolve)
- Modify: `frontend/lib/realtime.ts` (alert bump already carries the new fields — no shape change; verify)
- Modify: `frontend/app/events/page.tsx` (severity/status filter — optional, include a severity filter)

**Interfaces:**
- Consumes: `api.ackAlert/resolveAlert`, `Alert.severity/label/status`.

- [ ] **Step 1: Update the alert row in the tile**

In `frontend/components/CameraTile.tsx`, replace the alert-row body (the `alerts.slice(0, 5).map(...)` inner JSX) so each row shows a severity dot, the label, and ack/resolve buttons:

```tsx
            <div key={alert.id} className={`alert-row sev-${alert.severity ?? "low"} ${alert.status === "resolved" ? "resolved" : ""}`}>
              {alert.clipId ? (
                <button className="thumb-btn" title="Play clip" onClick={() => onPlayClip(alert.clipId!)}>
                  <img src={clipThumbUrl(alert.clipId)} alt="" className="thumb" />
                  <span className="play-badge">▶</span>
                </button>
              ) : (
                <span className={`dot sev-${alert.severity ?? "low"}`} />
              )}
              <span>{alert.count}× {alert.label ?? "person"}</span>
              <span className="conf">{Math.round((alert.confidence ?? 0) * 100)}%</span>
              <span className="time">{new Date(alert.ts).toLocaleTimeString()}</span>
              {alert.status !== "resolved" && (
                <span className="ack-actions">
                  {alert.status !== "acked" && <button onClick={() => ackAlert(alert.id)}>Ack</button>}
                  <button onClick={() => resolveAlert(alert.id)}>Resolve</button>
                </span>
              )}
            </div>
```

Add the handlers inside the component (they optimistically update local state via the parent's alert list is out of scope — simplest: call the API then rely on the next poll/WS; for immediate feedback, keep a local `Set` of acked/resolved ids):

```tsx
  const [localStatus, setLocalStatus] = useState<Record<string, string>>({});
  async function ackAlert(id: string) { await api.ackAlert(id); setLocalStatus((s) => ({ ...s, [id]: "acked" })); }
  async function resolveAlert(id: string) { await api.resolveAlert(id); setLocalStatus((s) => ({ ...s, [id]: "resolved" })); }
```
and read `const status = localStatus[alert.id] ?? alert.status;` to drive the row (use `status` in place of `alert.status` above).

- [ ] **Step 2: Styles**

Append to `frontend/app/globals.css`:
```css
.dot.sev-low { background: #3b82f6; } .dot.sev-medium { background: #f59e0b; } .dot.sev-high { background: #ef4444; }
.alert-row.resolved { opacity: 0.5; }
.ack-actions { display: inline-flex; gap: 4px; margin-left: auto; }
.ack-actions button { font-size: 11px; padding: 1px 6px; }
```

- [ ] **Step 3: Build**

Run: `cd frontend && npm run build` → compiles.

- [ ] **Step 4: Commit**

```bash
git add frontend/components/CameraTile.tsx frontend/app/globals.css
git commit -m "feat(web): alert rows show severity + label + ack/resolve"
```

---

### Task 15: Infra/config + end-to-end verification

**Files:**
- Modify: `.env.example` (`TZ`, `MODEL_CLASSES`)
- Modify: `README.md` (config rows + a rules note)
- Modify: `docker-compose.yml` (pass `TZ` to worker if desired — optional)

**Interfaces:** none (docs/config + the DoD smoke test).

- [ ] **Step 1: Env docs**

Append to `.env.example`:
```bash

# ---- rules engine (M2a) ----
# worker: comma-separated detection classes + timezone for schedule windows
MODEL_CLASSES=person,bicycle,car,motorcycle,bus,truck,cat,dog,backpack,handbag,suitcase
TZ=UTC
```
Add matching rows to the README Configuration table (`MODEL_CLASSES`, `TZ`) and a one-line note that cameras support zones + rules (see the M2a spec).

- [ ] **Step 2: Full suites green**

Run: `cd backend && DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun test` → all pass.
Run: `cd worker && python3 -m unittest discover -s tests -v` → all pass.
Run: `cd frontend && npm run build` → compiles.

- [ ] **Step 3: End-to-end smoke (docker)**

Run: `docker compose up -d --build backend worker mediamtx streamer`
Then via the API (login demo/demo12345):
1. Start the seeded camera → confirm it still alerts on people (implicit default; `GET /alerts` shows `label: "person"`, `severity: "low"`, `rule_id: null`).
2. Create a zone (polygon) + a rule `{ classes:["person"], zoneId, severity:"high" }`; confirm a `rules_update` reaches the worker (worker log `updated rules for camera …`).
3. Confirm a person inside the zone now raises a `severity: "high"` alert tagged with `rule_id`; a rule with an out-of-now schedule produces no alert.
4. `POST /alerts/:id/ack` then `/resolve` → status transitions.
Expected: all of the above; M1 clips still attach to the (now rule-tagged) alerts.

- [ ] **Step 4: Commit**

```bash
git add .env.example README.md docker-compose.yml
git commit -m "chore(infra): rules-engine env + docs; M2a end-to-end verified"
```

---

## Self-Review

**Spec coverage** (against `docs/superpowers/specs/2026-07-08-m2a-zone-class-rules-engine-design.md`):
- Multi-class detection → Task 6. ✔
- Zones (draw + store) → Tasks 1, 2, 12. ✔
- Rules (class + zone + schedule + min-conf + severity + enabled) → Tasks 1, 3, 13. ✔
- Rule eval (point-in-polygon bottom-center, schedule wrap, per-rule dedup, implicit default) → Tasks 7, 8, 10. ✔
- Rules delivery (start embeds, rules_update live) → Tasks 4, 10. ✔
- Alert label/ruleId/severity/status + ack/resolve + filters → Tasks 1, 5, 9, 14. ✔
- Zone editor (client-side snapshot) → Task 12. ✔
- Rules UI + alert severity/ack UI → Tasks 13, 14. ✔
- Event contract updates → Task 9. ✔
- Backward-compat (implicit default; existing rows default) → Tasks 1, 7. ✔
- Timezone schedules → Tasks 6 (config), 7, 10. ✔
- Testing (pure worker units; DB-backed API; geometry helper) → Tasks 2–8, 11. ✔
- Infra/env + e2e → Task 15. ✔

**Placeholder scan:** no TBD/TODO; every code step shows complete code.

**Type/name consistency:** `detect_objects`/`Box.label` (Task 6) used in Tasks 7,10; `evaluate`/`Match` (Task 7) used in Task 10; `should_emit(key,…)` (Task 8) called with composite key in Task 10; `resolveRules`/`ResolvedRule` (Task 3) consumed in Task 4; `detection_event(…, label, rule_id, severity)` (Task 9) called in Task 10 and mapped in Task 5; `api.listAlerts(options)` signature change (Task 11) has its caller updated in the same task. ✔

**Known edges (documented):** the worker's heavy modules can't be imported on the host (Task 10 verified via py_compile + pure suite; runtime in Task 15). The `alerts.ruleId` is a plain uuid column (not FK) by design (insert-ordering + rule-deletion survivability). Schedule comparison relies on zero-padded `HH:MM` lexical ordering (validated by the `HHMM` regex in Task 3).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-08-m2a-rules-engine.md`.
