import { Hono } from "hono";
import { and, desc, eq, gte, lte, getTableColumns } from "drizzle-orm";
import { db } from "../db";
import { alerts, cameras, clips } from "../db/schema";
import { requireAuth } from "../auth/middleware";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const alertRoutes = new Hono();
alertRoutes.use("*", requireAuth);

// GET /alerts?camera_id=&from=&to=&limit=&offset=
// Always scoped to the caller's cameras via the inner join on ownership.
alertRoutes.get("/", async (c) => {
  const userId = c.get("userId");
  const cameraId = c.req.query("camera_id");
  const from = c.req.query("from");
  const to = c.req.query("to");
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50), 1), 200);
  const offset = Math.max(Number(c.req.query("offset") ?? 0), 0);

  if (cameraId && !UUID_RE.test(cameraId)) {
    return c.json({ error: "camera_id must be a uuid" }, 400);
  }

  const conds = [eq(cameras.userId, userId)];
  if (cameraId) conds.push(eq(alerts.cameraId, cameraId));
  if (from && !Number.isNaN(Date.parse(from))) {
    conds.push(gte(alerts.ts, new Date(from)));
  }
  if (to && !Number.isNaN(Date.parse(to))) {
    conds.push(lte(alerts.ts, new Date(to)));
  }
  const severity = c.req.query("severity");
  const status = c.req.query("status");
  if (severity) conds.push(eq(alerts.severity, severity));
  if (status) conds.push(eq(alerts.status, status));

  const rows = await db
    .select({ ...getTableColumns(alerts), clipId: clips.id })
    .from(alerts)
    .innerJoin(cameras, eq(alerts.cameraId, cameras.id))
    .leftJoin(clips, eq(clips.alertId, alerts.id))
    .where(and(...conds))
    .orderBy(desc(alerts.ts))
    .limit(limit)
    .offset(offset);

  return c.json({ alerts: rows, limit, offset, count: rows.length });
});

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
