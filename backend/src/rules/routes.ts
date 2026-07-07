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

// mounted at /cameras/:cameraId/zones. The BasePath type param lets Hono type
// c.req.param("cameraId") as `string` even though this sub-router only owns
// the "/cameras/:cameraId/zones" segment, not "cameraId" itself.
export const zoneRoutes = new Hono<{}, {}, "/cameras/:cameraId/zones">();
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
  if (!UUID_RE.test(c.req.param("zoneId"))) return c.json({ error: "not found" }, 404);
  const b = await c.req.json().catch(() => ({}));
  const patch: Record<string, unknown> = {};
  if (typeof b.name === "string") patch.name = b.name.trim();
  if (b.polygon !== undefined) {
    if (!validPolygon(b.polygon)) return c.json({ error: "polygon must be >=3 points in [0,1]" }, 400);
    patch.polygon = b.polygon;
  }
  if (Object.keys(patch).length === 0) return c.json({ error: "nothing to update" }, 400);
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
  if (!UUID_RE.test(c.req.param("zoneId"))) return c.json({ error: "not found" }, 404);
  await db.delete(zones).where(and(eq(zones.id, c.req.param("zoneId")), eq(zones.cameraId, cam.id)));
  return c.body(null, 204);
});
