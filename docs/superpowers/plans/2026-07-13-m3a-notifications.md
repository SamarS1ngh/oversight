# M3a Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an alert is persisted, dispatch it to the owner's configured notification channels (webhook, ntfy, Telegram) so a security event reaches a phone/Slack/automation instantly.

**Architecture:** Entirely API-side, no worker changes. `ingest.ts onDetection` (which already inserts the alert + fans it out over WS) gains one non-blocking call — `void dispatchNotifications(d, ownerId)` — that loads the owner's enabled channels, filters by min-severity + camera, respects a per-(channel,camera) cooldown, renders a text+link message, and POSTs via a per-type driver. Pure logic (filter/cooldown/render/buildRequest) is unit-tested; the `fetch` (`send`) is thin.

**Tech Stack:** Bun + Hono 4 + Drizzle 0.36 (Postgres), Next.js 15 / React 19.

## Global Constraints

- **Notifications are best-effort and MUST NOT block or fail alert persistence.** The dispatch call is `void`-ed and every send is wrapped in try/catch; a failing channel logs (`console.error`) and never affects ingest, WS fanout, or sibling channels.
- **Fire on the alert** (in `onDetection`), text + a tap-through link `${APP_URL}/events?camera=<cameraId>`. `APP_URL` env default `http://localhost:3000`.
- **The notifier receives the detection event `d`** (snake_case: `d.severity`, `d.camera_id`, `d.label`, `d.rule_id`, `d.id`, `d.ts`, `d.count`, `d.confidence`), the same object fanned out to the WS. `render` maps to camelCase for the webhook payload.
- **Channels:** `type ∈ {webhook, ntfy, telegram}`. Per-type `config`: webhook `{url}`; ntfy `{topic, server?, token?}` (server default `https://ntfy.sh`); telegram `{botToken, chatId}`.
- **Filter:** fire when `sevRank(alert.severity) >= sevRank(channel.minSeverity)` AND (`channel.cameraIds == null` OR includes the alert's camera). `sevRank`: low=0, medium=1, high=2.
- **Cooldown:** per key `channelId + ":" + cameraId`, default 60s, in-memory; `cooldownSecs <= 0` disables it.
- **ntfy priority map:** low=2, medium=3, high=5.
- **Ownership scoping:** channels belong to `userId`; another user gets 404 on read/patch/delete/test. UUID-guard `:id`.
- **No import-time side effects in `app.ts`** (dispatch is called from `onDetection`, which runs from `index.ts`'s `startIngest`).
- **Commits:** author is Samar only. No `Co-Authored-By: Claude` trailer.
- Commands: backend `cd backend && bun test` (DB-backed need `DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms`); migrate `cd backend && bun run db:push`; frontend `cd frontend && npm run build`.

---

### Task 1: `notification_channels` table + migration

**Files:**
- Modify: `backend/src/db/schema.ts`

**Interfaces:**
- Produces: `notificationChannels` table (`id, userId, type, name, config jsonb, minSeverity, cameraIds jsonb, cooldownSecs, enabled, createdAt`), index on `userId`, and `NotifChannel` type.

- [ ] **Step 1: Add the table**

In `backend/src/db/schema.ts`, after the `rules` table (before the `export type` lines), add:

```ts
// A user's notification destination (webhook / ntfy / telegram). Config holds the
// per-type target + secrets. See docs/superpowers/specs M3a.
export const notificationChannels = pgTable(
  "notification_channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(), // 'webhook' | 'ntfy' | 'telegram'
    name: text("name").notNull(),
    config: jsonb("config").notNull(),
    minSeverity: text("min_severity").notNull().default("low"),
    cameraIds: jsonb("camera_ids"), // string[] | null (null = all)
    cooldownSecs: integer("cooldown_secs").notNull().default(60),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({ userIdx: index("notification_channels_user_idx").on(t.userId) }),
);
```

Add the type export at the bottom:

```ts
export type NotifChannel = typeof notificationChannels.$inferSelect;
```

- [ ] **Step 2: Migrate**

Run: `cd backend && DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun run db:push`
Expected: drizzle-kit creates `notification_channels` + index. (Start `docker compose up -d postgres` first if needed.)

- [ ] **Step 3: Typecheck + commit**

Run: `cd backend && bunx tsc --noEmit` → no errors.

```bash
git add backend/src/db/schema.ts
git commit -m "feat(db): notification_channels table"
```

---

### Task 2: Filter + cooldown (pure, TDD)

**Files:**
- Create: `backend/src/notify/filter.ts`
- Create: `backend/src/notify/cooldown.ts`
- Create: `backend/test/notify.test.ts`

**Interfaces:**
- Produces: `sevRank(s): number`; `shouldNotify(channel, alert): boolean`; `allow(key, nowMs, cooldownSecs): boolean` (records send time on true) + `_reset()` (test helper to clear the map).

- [ ] **Step 1: Write the failing tests**

Create `backend/test/notify.test.ts`:

```ts
import { test, expect } from "bun:test";
import { sevRank, shouldNotify } from "../src/notify/filter";
import { allow, _reset } from "../src/notify/cooldown";

test("sevRank orders severities", () => {
  expect(sevRank("low")).toBe(0);
  expect(sevRank("high")).toBeGreaterThan(sevRank("medium"));
});

test("shouldNotify respects min severity", () => {
  const ch = { minSeverity: "high", cameraIds: null } as any;
  expect(shouldNotify(ch, { severity: "high", camera_id: "c1" })).toBe(true);
  expect(shouldNotify(ch, { severity: "low", camera_id: "c1" })).toBe(false);
});

test("shouldNotify respects the camera set (null = all)", () => {
  const all = { minSeverity: "low", cameraIds: null } as any;
  const one = { minSeverity: "low", cameraIds: ["c1"] } as any;
  expect(shouldNotify(all, { severity: "low", camera_id: "cX" })).toBe(true);
  expect(shouldNotify(one, { severity: "low", camera_id: "c1" })).toBe(true);
  expect(shouldNotify(one, { severity: "low", camera_id: "c2" })).toBe(false);
});

test("cooldown allows first, suppresses within window, allows after", () => {
  _reset();
  expect(allow("k", 0, 60)).toBe(true);
  expect(allow("k", 30_000, 60)).toBe(false);
  expect(allow("k", 61_000, 60)).toBe(true);
});

test("cooldown of 0 always allows", () => {
  _reset();
  expect(allow("z", 0, 0)).toBe(true);
  expect(allow("z", 1, 0)).toBe(true);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd backend && bun test test/notify.test.ts`
Expected: FAIL — cannot resolve `../src/notify/filter`.

- [ ] **Step 3: Implement filter.ts**

Create `backend/src/notify/filter.ts`:

```ts
const RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

export function sevRank(s: string): number {
  return RANK[s] ?? 0;
}

// `channel` has minSeverity + cameraIds; `alert` is the detection event (snake_case).
export function shouldNotify(
  channel: { minSeverity: string; cameraIds: unknown },
  alert: { severity?: string; camera_id: string },
): boolean {
  if (sevRank(alert.severity ?? "low") < sevRank(channel.minSeverity)) return false;
  const cams = channel.cameraIds as string[] | null;
  if (cams != null && !cams.includes(alert.camera_id)) return false;
  return true;
}
```

- [ ] **Step 4: Implement cooldown.ts**

Create `backend/src/notify/cooldown.ts`:

```ts
// In-memory last-send time per "channelId:cameraId". Best-effort rate limit that
// resets on API restart — good enough to stop phone spam from a busy scene.
const last = new Map<string, number>();

export function allow(key: string, nowMs: number, cooldownSecs: number): boolean {
  if (cooldownSecs <= 0) return true;
  const prev = last.get(key);
  if (prev !== undefined && nowMs - prev < cooldownSecs * 1000) return false;
  last.set(key, nowMs);
  return true;
}

export function _reset(): void {
  last.clear();
}
```

- [ ] **Step 5: Run to verify pass + commit**

Run: `cd backend && bun test test/notify.test.ts` → PASS (5 tests).

```bash
git add backend/src/notify/filter.ts backend/src/notify/cooldown.ts backend/test/notify.test.ts
git commit -m "feat(api): notification filter + cooldown (pure)"
```

---

### Task 3: Render + buildRequest (pure, TDD)

**Files:**
- Create: `backend/src/notify/render.ts`
- Create: `backend/src/notify/drivers.ts`
- Modify: `backend/test/notify.test.ts`

**Interfaces:**
- Consumes: `sevRank` (Task 2).
- Produces: `renderAlert(type, alert, cameraName, ruleName, link)` → per-type payload object; `buildRequest(type, config, payload)` → `{ url, method, headers, body }`.

- [ ] **Step 1: Write the failing tests**

Add to `backend/test/notify.test.ts`:

```ts
import { renderAlert } from "../src/notify/render";
import { buildRequest } from "../src/notify/drivers";

const ALERT = { id: "a1", severity: "high", label: "person", rule_id: "r1", camera_id: "c1", ts: "2026-07-13T22:32:00.000Z", count: 2, confidence: 0.91 };
const LINK = "http://app/events?camera=c1";

test("renderAlert webhook payload maps snake->camel + includes link", () => {
  const p: any = renderAlert("webhook", ALERT, "Driveway", "Night", LINK);
  expect(p.event).toBe("alert");
  expect(p.alert.cameraId).toBe("c1");
  expect(p.alert.severity).toBe("high");
  expect(p.camera.name).toBe("Driveway");
  expect(p.rule.name).toBe("Night");
  expect(p.url).toBe(LINK);
});

test("renderAlert ntfy maps severity to priority + carries click", () => {
  const p: any = renderAlert("ntfy", ALERT, "Driveway", "Night", LINK);
  expect(p.priority).toBe(5); // high
  expect(p.click).toBe(LINK);
  expect(p.title).toContain("Driveway");
});

test("renderAlert telegram has markdown text with the link", () => {
  const p: any = renderAlert("telegram", ALERT, "Driveway", null, LINK);
  expect(p.parse_mode).toBe("Markdown");
  expect(p.text).toContain(LINK);
  expect(p.text).toContain("detection"); // null ruleName -> "detection"
});

test("buildRequest webhook is a JSON POST to config.url", () => {
  const r = buildRequest("webhook", { url: "http://hook" }, { event: "alert" });
  expect(r.url).toBe("http://hook");
  expect(r.method).toBe("POST");
  expect(r.headers["content-type"]).toBe("application/json");
  expect(JSON.parse(r.body).event).toBe("alert");
});

test("buildRequest ntfy posts to server/topic with headers + optional auth", () => {
  const p = { title: "T", body: "B", priority: 5, tags: ["high"], click: LINK };
  const noAuth = buildRequest("ntfy", { topic: "mytopic" }, p);
  expect(noAuth.url).toBe("https://ntfy.sh/mytopic");
  expect(noAuth.headers["Title"]).toBe("T");
  expect(noAuth.headers["Priority"]).toBe("5");
  expect(noAuth.headers["Authorization"]).toBeUndefined();
  expect(noAuth.body).toBe("B");
  const auth = buildRequest("ntfy", { topic: "t", server: "https://n.example", token: "tok" }, p);
  expect(auth.url).toBe("https://n.example/t");
  expect(auth.headers["Authorization"]).toBe("Bearer tok");
});

test("buildRequest telegram posts to the bot sendMessage with chat_id", () => {
  const r = buildRequest("telegram", { botToken: "BT", chatId: "123" }, { text: "hi", parse_mode: "Markdown" });
  expect(r.url).toBe("https://api.telegram.org/botBT/sendMessage");
  const b = JSON.parse(r.body);
  expect(b.chat_id).toBe("123");
  expect(b.text).toBe("hi");
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd backend && bun test test/notify.test.ts` → new tests FAIL (modules missing).

- [ ] **Step 3: Implement render.ts**

Create `backend/src/notify/render.ts`:

```ts
type Alert = {
  id: string; severity?: string; label?: string | null; rule_id?: string | null;
  camera_id: string; ts: string; count: number; confidence: number;
};
const NTFY_PRIORITY: Record<string, number> = { low: 2, medium: 3, high: 5 };

export function renderAlert(
  type: string,
  alert: Alert,
  cameraName: string,
  ruleName: string | null,
  link: string,
): Record<string, unknown> {
  const sev = alert.severity ?? "low";
  const label = alert.label ?? "detection";
  const rule = ruleName ?? "detection";
  if (type === "webhook") {
    return {
      event: "alert",
      alert: {
        id: alert.id, severity: sev, label: alert.label ?? null,
        ruleId: alert.rule_id ?? null, cameraId: alert.camera_id,
        ts: alert.ts, count: alert.count, confidence: alert.confidence,
      },
      camera: { id: alert.camera_id, name: cameraName },
      rule: alert.rule_id ? { id: alert.rule_id, name: ruleName } : null,
      url: link,
    };
  }
  if (type === "ntfy") {
    return {
      title: `${cameraName}: ${sev} ${label}`,
      body: `${rule} · ${alert.count}`,
      priority: NTFY_PRIORITY[sev] ?? 3,
      tags: [sev],
      click: link,
    };
  }
  // telegram
  const time = new Date(alert.ts).toLocaleString();
  return {
    text: `*${sev}* ${label} on *${cameraName}*\n${rule} · ${alert.count} · ${time}\n${link}`,
    parse_mode: "Markdown",
  };
}
```

- [ ] **Step 4: Implement drivers.ts (buildRequest + a thin send)**

Create `backend/src/notify/drivers.ts`:

```ts
export type OutReq = { url: string; method: string; headers: Record<string, string>; body: string };

export function buildRequest(type: string, config: any, payload: any): OutReq {
  if (type === "webhook") {
    return {
      url: config.url,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    };
  }
  if (type === "ntfy") {
    const server = (config.server ?? "https://ntfy.sh").replace(/\/$/, "");
    const headers: Record<string, string> = {
      Title: String(payload.title),
      Priority: String(payload.priority),
      Tags: (payload.tags ?? []).join(","),
      Click: String(payload.click),
    };
    if (config.token) headers["Authorization"] = `Bearer ${config.token}`;
    return { url: `${server}/${config.topic}`, method: "POST", headers, body: String(payload.body) };
  }
  // telegram
  return {
    url: `https://api.telegram.org/bot${config.botToken}/sendMessage`,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: config.chatId, ...payload }),
  };
}

// Thin real sender — not unit-tested (exercised by the routes capture test + e2e).
export async function send(req: OutReq): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
  return { ok: res.ok, status: res.status };
}
```

- [ ] **Step 5: Run to verify pass + commit**

Run: `cd backend && bun test test/notify.test.ts` → PASS (all render + buildRequest tests).

```bash
git add backend/src/notify/render.ts backend/src/notify/drivers.ts backend/test/notify.test.ts
git commit -m "feat(api): notification render + buildRequest (pure)"
```

---

### Task 4: Channels CRUD routes

**Files:**
- Create: `backend/src/notify/routes.ts`
- Modify: `backend/src/app.ts` (mount `/notifications`)
- Modify: `backend/test/notify.test.ts`

**Interfaces:**
- Consumes: `notificationChannels` schema (Task 1).
- Produces: `notifyRoutes` (Hono, mounted `/notifications`), exported `ownedChannel(userId, id)`. Routes: `GET`/`POST`/`PATCH /:id`/`DELETE /:id` (owner-scoped, validated).

- [ ] **Step 1: Write the failing tests**

Add to `backend/test/notify.test.ts` (mirrors the DB self-skip guard in `test/api.test.ts`):

```ts
import { beforeAll } from "bun:test";
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

test("notifications require auth", async () => {
  expect((await call("/notifications")).status).toBe(401);
});

test("create + list a channel, owner-scoped", async () => {
  if (!dbUp) return;
  const a = await nuser();
  const created = await a(`/notifications`, json({ type: "ntfy", name: "phone", config: { topic: "mytopic" }, minSeverity: "high" }));
  expect(created.status).toBe(201);
  const ch = await created.json();
  expect(ch.type).toBe("ntfy");
  const list = await (await a(`/notifications`)).json();
  expect(list.map((x: any) => x.id)).toContain(ch.id);
  // another user can't see / delete it
  const b = await nuser();
  expect((await b(`/notifications/${ch.id}`, { method: "DELETE" })).status).toBe(404);
});

test("validation: bad type / missing per-type config / bad severity", async () => {
  if (!dbUp) return;
  const a = await nuser();
  expect((await a(`/notifications`, json({ type: "carrier-pigeon", name: "x", config: {} }))).status).toBe(400);
  expect((await a(`/notifications`, json({ type: "webhook", name: "x", config: {} }))).status).toBe(400); // no url
  expect((await a(`/notifications`, json({ type: "telegram", name: "x", config: { botToken: "b" } }))).status).toBe(400); // no chatId
  expect((await a(`/notifications`, json({ type: "ntfy", name: "x", config: { topic: "t" }, minSeverity: "urgent" }))).status).toBe(400);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd backend && DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun test test/notify.test.ts`
Expected: FAIL — `/notifications` 404 / not mounted.

- [ ] **Step 3: Implement the routes**

Create `backend/src/notify/routes.ts`:

```ts
import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { notificationChannels } from "../db/schema";
import { requireAuth } from "../auth/middleware";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES = ["webhook", "ntfy", "telegram"];
const SEVERITIES = ["low", "medium", "high"];

export async function ownedChannel(userId: string, id: string) {
  if (!UUID_RE.test(id)) return null;
  const [ch] = await db
    .select()
    .from(notificationChannels)
    .where(and(eq(notificationChannels.id, id), eq(notificationChannels.userId, userId)))
    .limit(1);
  return ch ?? null;
}

// null if valid, else an error string.
export function validateChannel(b: any): string | null {
  if (!b?.name?.trim()) return "name required";
  if (!TYPES.includes(b.type)) return "type must be webhook|ntfy|telegram";
  if (b.minSeverity !== undefined && !SEVERITIES.includes(b.minSeverity)) return "minSeverity must be low|medium|high";
  if (b.cooldownSecs !== undefined && (typeof b.cooldownSecs !== "number" || b.cooldownSecs < 0)) return "cooldownSecs must be >= 0";
  if (b.cameraIds !== undefined && b.cameraIds !== null && !(Array.isArray(b.cameraIds) && b.cameraIds.every((x: any) => typeof x === "string"))) return "cameraIds must be null or string[]";
  const cfg = b.config ?? {};
  if (b.type === "webhook" && !cfg.url) return "webhook config needs a url";
  if (b.type === "ntfy" && !cfg.topic) return "ntfy config needs a topic";
  if (b.type === "telegram" && (!cfg.botToken || !cfg.chatId)) return "telegram config needs botToken + chatId";
  return null;
}

export const notifyRoutes = new Hono();
notifyRoutes.use("*", requireAuth);

notifyRoutes.get("/", async (c) => {
  const rows = await db.select().from(notificationChannels)
    .where(eq(notificationChannels.userId, c.get("userId")))
    .orderBy(desc(notificationChannels.createdAt));
  return c.json(rows);
});

notifyRoutes.post("/", async (c) => {
  const b = await c.req.json().catch(() => null);
  const err = validateChannel(b);
  if (err) return c.json({ error: err }, 400);
  const [ch] = await db.insert(notificationChannels).values({
    userId: c.get("userId"),
    type: b.type, name: b.name.trim(), config: b.config,
    minSeverity: b.minSeverity ?? "low",
    cameraIds: b.cameraIds ?? null,
    cooldownSecs: typeof b.cooldownSecs === "number" ? b.cooldownSecs : 60,
    enabled: typeof b.enabled === "boolean" ? b.enabled : true,
  }).returning();
  return c.json(ch, 201);
});

notifyRoutes.patch("/:id", async (c) => {
  const cur = await ownedChannel(c.get("userId"), c.req.param("id"));
  if (!cur) return c.json({ error: "not found" }, 404);
  const b = await c.req.json().catch(() => ({}));
  // validate the merged effective channel (partial updates)
  const merged = { type: b.type ?? cur.type, name: b.name ?? cur.name, config: b.config ?? cur.config, minSeverity: b.minSeverity ?? cur.minSeverity, cooldownSecs: b.cooldownSecs, cameraIds: b.cameraIds };
  const err = validateChannel(merged);
  if (err) return c.json({ error: err }, 400);
  const patch: Record<string, unknown> = {};
  for (const k of ["type", "name", "config", "minSeverity", "cameraIds", "cooldownSecs", "enabled"]) {
    if (b[k] !== undefined) patch[k] = k === "name" ? String(b[k]).trim() : b[k];
  }
  const [updated] = await db.update(notificationChannels).set(patch)
    .where(and(eq(notificationChannels.id, cur.id), eq(notificationChannels.userId, c.get("userId")))).returning();
  return c.json(updated);
});

notifyRoutes.delete("/:id", async (c) => {
  const cur = await ownedChannel(c.get("userId"), c.req.param("id"));
  if (!cur) return c.json({ error: "not found" }, 404);
  await db.delete(notificationChannels).where(eq(notificationChannels.id, cur.id));
  return c.body(null, 204);
});
```

- [ ] **Step 4: Mount it**

In `backend/src/app.ts` add the import + route (after `app.route("/clips", clipRoutes)`):

```ts
import { notifyRoutes } from "./notify/routes";
// ...
app.route("/notifications", notifyRoutes);
```

- [ ] **Step 5: Run to verify pass + commit**

Run: `cd backend && DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun test test/notify.test.ts` → PASS.

```bash
git add backend/src/notify/routes.ts backend/src/app.ts backend/test/notify.test.ts
git commit -m "feat(api): notification channels CRUD (owner-scoped, validated)"
```

---

### Task 5: Dispatch + test endpoint + wire into ingest

**Files:**
- Create: `backend/src/notify/dispatch.ts`
- Modify: `backend/src/notify/routes.ts` (add `POST /:id/test`)
- Modify: `backend/src/realtime/ingest.ts` (call dispatch after fanout)
- Modify: `backend/src/env.ts` (`APP_URL`)
- Modify: `backend/test/notify.test.ts` (capture-server test for the test endpoint)

**Interfaces:**
- Consumes: `shouldNotify`/`allow`/`renderAlert`/`buildRequest`/`send`, `notificationChannels`, `cameras`, `rules`.
- Produces: `dispatchNotifications(alert, ownerId): Promise<void>`; `POST /notifications/:id/test` → `{ ok, status }`.

- [ ] **Step 1: Add `APP_URL` to env**

In `backend/src/env.ts`, add to the `env` object:

```ts
  APP_URL: process.env.APP_URL ?? "http://localhost:3000",
```

- [ ] **Step 2: Implement dispatch.ts**

Create `backend/src/notify/dispatch.ts`:

```ts
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { notificationChannels, cameras, rules } from "../db/schema";
import { env } from "../env";
import { shouldNotify } from "./filter";
import { allow } from "./cooldown";
import { renderAlert } from "./render";
import { buildRequest, send } from "./drivers";

// Fire-and-forget: dispatch one persisted alert (the detection event `d`, snake_case)
// to the owner's enabled channels. Never throws to the caller.
export async function dispatchNotifications(alert: any, ownerId: string): Promise<void> {
  try {
    const channels = await db.select().from(notificationChannels)
      .where(and(eq(notificationChannels.userId, ownerId), eq(notificationChannels.enabled, true)));
    if (channels.length === 0) return;

    const [cam] = await db.select({ name: cameras.name }).from(cameras).where(eq(cameras.id, alert.camera_id)).limit(1);
    const cameraName = cam?.name ?? "camera";
    let ruleName: string | null = null;
    if (alert.rule_id) {
      const [r] = await db.select({ name: rules.name }).from(rules).where(eq(rules.id, alert.rule_id)).limit(1);
      ruleName = r?.name ?? null;
    }
    const link = `${env.APP_URL}/events?camera=${alert.camera_id}`;
    const now = Date.now();

    for (const ch of channels) {
      try {
        if (!shouldNotify(ch, alert)) continue;
        if (!allow(`${ch.id}:${alert.camera_id}`, now, ch.cooldownSecs)) continue;
        const payload = renderAlert(ch.type, alert, cameraName, ruleName, link);
        await send(buildRequest(ch.type, ch.config, payload));
      } catch (e) {
        console.error(`[notify] channel ${ch.id} (${ch.type}) failed:`, (e as Error).message);
      }
    }
  } catch (e) {
    console.error("[notify] dispatch failed:", (e as Error).message);
  }
}
```

- [ ] **Step 3: Add the test endpoint to routes.ts**

Append to `backend/src/notify/routes.ts` (imports: add `renderAlert`, `buildRequest`, `send`, `env`, `cameras`):

```ts
notifyRoutes.post("/:id/test", async (c) => {
  const ch = await ownedChannel(c.get("userId"), c.req.param("id"));
  if (!ch) return c.json({ error: "not found" }, 404);
  const [cam] = await db.select({ id: cameras.id, name: cameras.name }).from(cameras)
    .where(eq(cameras.userId, c.get("userId"))).limit(1);
  const cameraId = cam?.id ?? "00000000-0000-0000-0000-000000000000";
  const synthetic = { id: "test", severity: "high", label: "test", rule_id: null, camera_id: cameraId, ts: new Date().toISOString(), count: 1, confidence: 1 };
  const link = `${env.APP_URL}/events?camera=${cameraId}`;
  try {
    const payload = renderAlert(ch.type, synthetic, cam?.name ?? "test camera", "test", link);
    const res = await send(buildRequest(ch.type, ch.config, payload));
    return c.json({ ok: res.ok, status: res.status });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 200);
  }
});
```
Add to the top-of-file imports: `import { notificationChannels, cameras } from "../db/schema";` (replace the existing single-name import), `import { renderAlert } from "./render";`, `import { buildRequest, send } from "./drivers";`, `import { env } from "../env";`.

- [ ] **Step 4: Wire dispatch into `onDetection`**

In `backend/src/realtime/ingest.ts`:
1. Add import: `import { dispatchNotifications } from "../notify/dispatch";`
2. In `onDetection`, after the fanout line `if (owner) sendToUser(owner, { channel: "alert", data: d });`, add:

```ts
  if (owner) void dispatchNotifications(d, owner);
```

- [ ] **Step 5: Write the capture-server test (test endpoint delivers)**

Add to `backend/test/notify.test.ts`:

```ts
test("POST /notifications/:id/test delivers to a webhook", async () => {
  if (!dbUp) return;
  const a = await nuser();
  // a local server that captures the POST
  let received: any = null;
  const server = Bun.serve({ port: 0, async fetch(req) { received = await req.json(); return new Response("ok"); } });
  const url = `http://127.0.0.1:${server.port}/hook`;
  const ch = await (await a(`/notifications`, json({ type: "webhook", name: "hook", config: { url } }))).json();
  const res = await a(`/notifications/${ch.id}/test`, { method: "POST" });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(received?.event).toBe("alert");
  expect(received?.alert?.severity).toBe("high");
  server.stop();
});
```

- [ ] **Step 6: Run + commit**

Run: `cd backend && DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun test` (whole suite) → all pass; `bunx tsc --noEmit` clean.

```bash
git add backend/src/notify/dispatch.ts backend/src/notify/routes.ts backend/src/realtime/ingest.ts backend/src/env.ts backend/test/notify.test.ts
git commit -m "feat(api): dispatch notifications on alert + per-channel test endpoint"
```

---

### Task 6: Frontend types + API client

**Files:**
- Modify: `frontend/lib/types.ts`
- Modify: `frontend/lib/api.ts`

**Interfaces:**
- Produces: `NotifChannelType`, `NotifChannel` type; `api.listChannels/createChannel/updateChannel/deleteChannel/testChannel`.

- [ ] **Step 1: Add the type**

In `frontend/lib/types.ts` add:

```ts
export type NotifChannelType = "webhook" | "ntfy" | "telegram";

export type NotifChannel = {
  id: string;
  type: NotifChannelType;
  name: string;
  config: Record<string, string>;
  minSeverity: Severity;
  cameraIds: string[] | null;
  cooldownSecs: number;
  enabled: boolean;
  createdAt: string;
};
```

- [ ] **Step 2: Add the API calls**

In `frontend/lib/api.ts`, add to the `api` object:

```ts
  listChannels: () => req("/notifications"),
  createChannel: (body: Record<string, unknown>) => req("/notifications", { method: "POST", body: JSON.stringify(body) }),
  updateChannel: (id: string, body: Record<string, unknown>) => req(`/notifications/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteChannel: (id: string) => req(`/notifications/${id}`, { method: "DELETE" }),
  testChannel: (id: string) => req(`/notifications/${id}/test`, { method: "POST" }),
```

- [ ] **Step 3: Build + commit**

Run: `cd frontend && npm run build` → compiles.

```bash
git add frontend/lib/types.ts frontend/lib/api.ts
git commit -m "feat(web): notification channel types + api client"
```

---

### Task 7: Notifications config page

**Files:**
- Create: `frontend/app/notifications/page.tsx`
- Modify: `frontend/app/dashboard/page.tsx` (topbar "Notifications" link)
- Modify: `frontend/app/globals.css` (minor)

**Interfaces:**
- Consumes: `api.listChannels/createChannel/deleteChannel/updateChannel/testChannel`, `api.listCameras`.
- Produces: `/notifications` route.

- [ ] **Step 1: Create the page**

Create `frontend/app/notifications/page.tsx`:

```tsx
"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, getToken } from "@/lib/api";
import type { Camera, NotifChannel } from "@/lib/types";

const TYPES = ["webhook", "ntfy", "telegram"] as const;
const empty = { type: "ntfy", name: "", config: {} as Record<string, string>, minSeverity: "low", cameraIds: null as string[] | null, cooldownSecs: 60, enabled: true };

const CONFIG_FIELDS: Record<string, string[]> = {
  webhook: ["url"],
  ntfy: ["topic", "server", "token"],
  telegram: ["botToken", "chatId"],
};

export default function NotificationsPage() {
  const router = useRouter();
  const [channels, setChannels] = useState<NotifChannel[]>([]);
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [form, setForm] = useState<any>(empty);
  const [err, setErr] = useState<string | null>(null);
  const [testMsg, setTestMsg] = useState<Record<string, string>>({});

  const load = () => api.listChannels().then(setChannels).catch(() => {});
  useEffect(() => {
    if (!getToken()) { router.replace("/login"); return; }
    load(); api.listCameras().then(setCameras).catch(() => {});
  }, [router]);

  async function save() {
    setErr(null);
    try {
      await api.createChannel({
        type: form.type, name: form.name, config: form.config,
        minSeverity: form.minSeverity, cameraIds: form.cameraIds,
        cooldownSecs: Number(form.cooldownSecs), enabled: form.enabled,
      });
      setForm(empty); load();
    } catch (e: any) { setErr(e.message); }
  }
  async function toggle(ch: NotifChannel) { await api.updateChannel(ch.id, { enabled: !ch.enabled }); load(); }
  async function del(ch: NotifChannel) { await api.deleteChannel(ch.id); load(); }
  async function test(ch: NotifChannel) {
    setTestMsg((m) => ({ ...m, [ch.id]: "…" }));
    try { const r = await api.testChannel(ch.id); setTestMsg((m) => ({ ...m, [ch.id]: r.ok ? "delivered" : `failed (${r.status ?? r.error})` })); }
    catch (e: any) { setTestMsg((m) => ({ ...m, [ch.id]: "failed" })); }
  }
  const setCfg = (k: string, v: string) => setForm((f: any) => ({ ...f, config: { ...f.config, [k]: v } }));

  return (
    <main className="dash">
      <header className="topbar">
        <h1>Notifications</h1>
        <div className="top-actions"><a href="/dashboard" className="btn">← Dashboard</a></div>
      </header>

      <div className="rules-list">
        {channels.length === 0 && <p className="muted small">No channels yet. Add one below to get alerts on your phone / Slack / automation.</p>}
        {channels.map((ch) => (
          <div key={ch.id} className="rule-row">
            <span className="badge">{ch.type}</span>
            <strong>{ch.name}</strong>
            <span className="muted small">≥{ch.minSeverity}{ch.cameraIds ? " · some cameras" : " · all cameras"} · {ch.cooldownSecs}s</span>
            <button onClick={() => test(ch)}>Test</button>
            {testMsg[ch.id] && <span className="muted small">{testMsg[ch.id]}</span>}
            <button onClick={() => toggle(ch)}>{ch.enabled ? "Disable" : "Enable"}</button>
            <button className="danger" onClick={() => del(ch)}>Delete</button>
          </div>
        ))}
      </div>
      <hr />
      <div className="rule-form">
        <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value, config: {} })}>
          {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        {CONFIG_FIELDS[form.type].map((k) => (
          <input key={k} placeholder={k} value={form.config[k] ?? ""} onChange={(e) => setCfg(k, e.target.value)} />
        ))}
        <label>Min severity
          <select value={form.minSeverity} onChange={(e) => setForm({ ...form, minSeverity: e.target.value })}>
            <option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
          </select>
        </label>
        <label>Cooldown s <input type="number" min="0" value={form.cooldownSecs} onChange={(e) => setForm({ ...form, cooldownSecs: e.target.value })} /></label>
        {err && <p className="error">{err}</p>}
        <button className="primary" onClick={save} disabled={!form.name}>Add channel</button>
      </div>
    </main>
  );
}
```
(Cameras filter is left as "all" for v1 — `cameraIds: null`. The cameras list is loaded for a future multiselect; keep the import so the page compiles and the follow-up is easy.)

- [ ] **Step 2: Topbar link**

In `frontend/app/dashboard/page.tsx`, add inside `.top-actions` (before the Logout button):

```tsx
          <a href="/notifications" className="btn">Notifications</a>
```

- [ ] **Step 3: Build + commit**

Run: `cd frontend && npm run build` → compiles; `/notifications` in the route list.

```bash
git add frontend/app/notifications/page.tsx frontend/app/dashboard/page.tsx frontend/app/globals.css
git commit -m "feat(web): notifications config page + test button"
```

---

### Task 8: Infra/docs + end-to-end verification

**Files:**
- Modify: `.env.example` (`APP_URL`), `README.md` (notifications note)

**Interfaces:** none (DoD smoke test).

- [ ] **Step 1: Docs**

Append `APP_URL=http://localhost:3000` to `.env.example` (backend section) and add a README line that alerts can be delivered to webhook / ntfy / Telegram channels (configured under Notifications), with `APP_URL` set to the reachable frontend URL for the tap-through link.

- [ ] **Step 2: Full suites green**

Run: `cd backend && DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun test` → all pass.
Run: `cd frontend && npm run build` → compiles.

- [ ] **Step 3: End-to-end smoke (docker)**

Run: `docker compose up -d --build backend worker mediamtx streamer`
Then (login demo/demo12345):
1. Add a **webhook** channel via the UI (or API) pointing at a local capture server (`python3 -m http.server` won't accept POST; use a tiny `Bun.serve` or `nc`/webhook.site). Hit **Test** → server receives the alert JSON with the `url` link.
2. Start the seeded camera → a real person detection POSTs a notification to the webhook (label=person, severity, camera name, link).
3. Add a channel with `minSeverity=high` → only high-severity (e.g. a tripwire) alerts fire it; low-severity presence alerts don't.
4. Confirm two rapid alerts on one camera collapse to one notification within the cooldown window, and that a failing channel (bad url) logs `[notify]` but never breaks alert persistence (alerts still appear in `GET /alerts`).
Expected: all of the above.

- [ ] **Step 4: Commit**

```bash
git add .env.example README.md
git commit -m "chore: document notification channels + APP_URL; M3a end-to-end verified"
```

---

## Self-Review

**Spec coverage** (against `docs/superpowers/specs/2026-07-13-m3a-notifications-design.md`):
- `notification_channels` table + CRUD + ownership → Tasks 1, 4. ✔
- Filter (severity + camera) → Task 2. ✔
- Cooldown per (channel,camera) → Task 2. ✔
- Render (webhook/ntfy/telegram) + severity→priority → Task 3. ✔
- buildRequest per type (+ ntfy auth) → Task 3. ✔
- Dispatch on alert from `onDetection`, non-blocking → Task 5. ✔
- Test endpoint → Task 5. ✔
- `APP_URL` link → Tasks 5, 8. ✔
- Frontend config page + test button → Tasks 6, 7. ✔
- Best-effort / failure isolation → Task 5 (try/catch per channel + outer). ✔
- Testing (pure filter/cooldown/render/build; DB CRUD + ownership + capture-server delivery) → Tasks 2, 3, 4, 5. ✔
- Docs + e2e → Task 8. ✔

**Placeholder scan:** no TBD/TODO; every code step has complete code.

**Type/name consistency:** `shouldNotify(channel, alert)`, `allow(key, nowMs, cooldownSecs)`, `renderAlert(type, alert, cameraName, ruleName, link)`, `buildRequest(type, config, payload)`, `send(req)`, `dispatchNotifications(alert, ownerId)` — signatures defined in Tasks 2/3 and consumed with the same shapes in Task 5. `notificationChannels` columns (Task 1) used in Tasks 4/5. `ownedChannel` (Task 4) reused by the test endpoint (Task 5). Frontend `NotifChannel` (Task 6) consumed in Task 7.

**Known edges (documented):** the notifier reads the detection event `d` (snake_case), render maps to camelCase for webhook; cooldown is in-memory (resets on restart — acceptable, best-effort); channel config incl. tokens is returned to the owning user's UI (self-hosted, own data); `send` (real fetch) is not unit-tested (exercised by the capture-server test + e2e).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-13-m3a-notifications.md`.
