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
