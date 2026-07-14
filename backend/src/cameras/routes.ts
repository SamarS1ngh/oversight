import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { cameras } from "../db/schema";
import { requireAuth } from "../auth/middleware";
import { publishCommand } from "../realtime/channels";
import { invalidateOwner } from "../realtime/connections";
import { requestAnswer } from "../realtime/signaling";
import { resolveRules } from "../rules/routes";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const cameraRoutes = new Hono();
cameraRoutes.use("*", requireAuth);

// Fetch a camera only if it belongs to this user. Guards the uuid syntax so a
// malformed :id returns 404 instead of a Postgres cast error.
async function getOwned(userId: string, id: string) {
  if (!UUID_RE.test(id)) return null;
  const [cam] = await db
    .select()
    .from(cameras)
    .where(and(eq(cameras.id, id), eq(cameras.userId, userId)))
    .limit(1);
  return cam ?? null;
}

cameraRoutes.get("/", async (c) => {
  const rows = await db
    .select()
    .from(cameras)
    .where(eq(cameras.userId, c.get("userId")))
    .orderBy(desc(cameras.createdAt));
  return c.json(rows);
});

cameraRoutes.get("/:id", async (c) => {
  const cam = await getOwned(c.get("userId"), c.req.param("id"));
  if (!cam) return c.json({ error: "not found" }, 404);
  return c.json(cam);
});

cameraRoutes.post("/", async (c) => {
  const b = await c.req.json().catch(() => null);
  const name = b?.name?.trim();
  const rtspUrl = b?.rtsp_url?.trim();
  if (!name || !rtspUrl) {
    return c.json({ error: "name and rtsp_url required" }, 400);
  }
  const [cam] = await db
    .insert(cameras)
    .values({
      userId: c.get("userId"),
      name,
      rtspUrl,
      location: b?.location ?? null,
      enabled: typeof b?.enabled === "boolean" ? b.enabled : true,
    })
    .returning();
  return c.json(cam, 201);
});

cameraRoutes.patch("/:id", async (c) => {
  const cam = await getOwned(c.get("userId"), c.req.param("id"));
  if (!cam) return c.json({ error: "not found" }, 404);

  const b = await c.req.json().catch(() => ({}));
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof b.name === "string") patch.name = b.name.trim();
  if (typeof b.rtsp_url === "string") patch.rtspUrl = b.rtsp_url.trim();
  if (typeof b.location === "string" || b.location === null) {
    patch.location = b.location;
  }
  if (typeof b.enabled === "boolean") patch.enabled = b.enabled;
  if (typeof b.notify_on_offline === "boolean") patch.notifyOnOffline = b.notify_on_offline;

  const [updated] = await db
    .update(cameras)
    .set(patch)
    .where(eq(cameras.id, cam.id))
    .returning();
  return c.json(updated);
});

cameraRoutes.delete("/:id", async (c) => {
  const cam = await getOwned(c.get("userId"), c.req.param("id"));
  if (!cam) return c.json({ error: "not found" }, 404);
  // best-effort stop so the worker tears down the stream before the row vanishes
  await publishCommand({
    type: "stop",
    camera_id: cam.id,
    requested_by: c.get("userId"),
    ts: new Date().toISOString(),
  });
  await db.delete(cameras).where(eq(cameras.id, cam.id));
  invalidateOwner(cam.id);
  return c.body(null, 204);
});

// WebRTC signaling: browser POSTs its SDP offer, we relay to the worker over
// Redis and return the worker's SDP answer. See realtime/signaling.ts.
cameraRoutes.post("/:id/webrtc", async (c) => {
  const cam = await getOwned(c.get("userId"), c.req.param("id"));
  if (!cam) return c.json({ error: "not found" }, 404);

  const body = await c.req.json().catch(() => null);
  const offer = body?.sdp;
  if (!offer || typeof offer !== "string") {
    return c.json({ error: "sdp offer required" }, 400);
  }

  const answer = await requestAnswer(cam.id, offer);
  if (answer.error || !answer.sdp) {
    return c.json({ error: answer.error ?? "no answer" }, 504);
  }
  return c.json({ type: "answer", sdp: answer.sdp });
});

cameraRoutes.post("/:id/start", async (c) => {
  const cam = await getOwned(c.get("userId"), c.req.param("id"));
  if (!cam) return c.json({ error: "not found" }, 404);
  if (!cam.enabled) return c.json({ error: "camera is disabled" }, 409);

  // optimistic state; the worker corrects it via state events (connecting->live/error)
  await db
    .update(cameras)
    .set({ status: "connecting", updatedAt: new Date() })
    .where(eq(cameras.id, cam.id));
  const resolved = await resolveRules(cam.id);
  await publishCommand({
    type: "start",
    camera_id: cam.id,
    rtsp_url: cam.rtspUrl,
    rules: resolved,
    requested_by: c.get("userId"),
    ts: new Date().toISOString(),
  });
  return c.json({ ok: true, status: "connecting" });
});

cameraRoutes.post("/:id/stop", async (c) => {
  const cam = await getOwned(c.get("userId"), c.req.param("id"));
  if (!cam) return c.json({ error: "not found" }, 404);

  await db
    .update(cameras)
    .set({ status: "stopped", updatedAt: new Date() })
    .where(eq(cameras.id, cam.id));
  await publishCommand({
    type: "stop",
    camera_id: cam.id,
    requested_by: c.get("userId"),
    ts: new Date().toISOString(),
  });
  return c.json({ ok: true, status: "stopped" });
});
