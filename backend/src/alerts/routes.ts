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
