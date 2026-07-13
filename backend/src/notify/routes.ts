import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { notificationChannels, cameras } from "../db/schema";
import { requireAuth } from "../auth/middleware";
import { renderAlert } from "./render";
import { buildRequest, send } from "./drivers";
import { env } from "../env";

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
  // Validate the merged effective channel (partial updates). Use key-presence
  // (not `??`) so an explicit `null` in the body is validated as the new
  // value rather than silently falling back to the current value — otherwise
  // an explicit null would pass validation against the old value but still
  // get written by the field-copy loop below, persisting an invalid channel.
  const merged = {
    type: "type" in b ? b.type : cur.type,
    name: "name" in b ? b.name : cur.name,
    config: "config" in b ? b.config : cur.config,
    minSeverity: "minSeverity" in b ? b.minSeverity : cur.minSeverity,
    cooldownSecs: "cooldownSecs" in b ? b.cooldownSecs : cur.cooldownSecs,
    cameraIds: "cameraIds" in b ? b.cameraIds : cur.cameraIds,
  };
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
