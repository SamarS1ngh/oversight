import { Hono } from "hono";
import { and, desc, eq, getTableColumns } from "drizzle-orm";
import { db } from "../db";
import { zones, rules, cameras } from "../db/schema";
import { requireAuth } from "../auth/middleware";
import { publishCommand } from "../realtime/channels";

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

function pointsInRange(p: unknown): p is { x: number; y: number }[] {
  return (
    Array.isArray(p) &&
    p.every(
      (pt: any) =>
        pt && typeof pt.x === "number" && typeof pt.y === "number" &&
        pt.x >= 0 && pt.x <= 1 && pt.y >= 0 && pt.y <= 1,
    )
  );
}
// A polygon needs >=3 points; a line needs exactly 2.
function validGeometry(kind: string, p: unknown): string | null {
  if (!pointsInRange(p)) return "points must be in [0,1]";
  const pts = p as { x: number; y: number }[];
  if (kind === "line") return pts.length === 2 ? null : "a line needs exactly 2 points";
  return pts.length >= 3 ? null : "a polygon needs >=3 points";
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
  const kind = b?.kind === "line" ? "line" : "polygon";
  const gErr = validGeometry(kind, b?.polygon);
  if (gErr) return c.json({ error: gErr }, 400);
  const [zone] = await db.insert(zones).values({ cameraId: cam.id, name, kind, polygon: b.polygon }).returning();
  await pushRulesIfRunning(cam, c.get("userId"));
  return c.json(zone, 201);
});

zoneRoutes.patch("/:zoneId", async (c) => {
  const cam = await ownedCamera(c.get("userId"), c.req.param("cameraId"));
  if (!cam) return c.json({ error: "not found" }, 404);
  if (!UUID_RE.test(c.req.param("zoneId"))) return c.json({ error: "not found" }, 404);
  const b = await c.req.json().catch(() => ({}));
  const patch: Record<string, unknown> = {};
  if (typeof b.name === "string") patch.name = b.name.trim();
  if (b.kind === "line" || b.kind === "polygon") patch.kind = b.kind;
  if (b.polygon !== undefined) {
    // validate against the new kind if provided, else the existing row's kind
    const [existing] = await db.select({ kind: zones.kind }).from(zones).where(and(eq(zones.id, c.req.param("zoneId")), eq(zones.cameraId, cam.id))).limit(1);
    if (!existing) return c.json({ error: "not found" }, 404);
    const kind = (patch.kind as string) ?? existing.kind;
    const gErr = validGeometry(kind, b.polygon);
    if (gErr) return c.json({ error: gErr }, 400);
    patch.polygon = b.polygon;
  } else if (patch.kind !== undefined) {
    // changing kind without new points: the existing points must fit the new kind
    // (a polygon's >=3 points can't be relabeled a line, which needs exactly 2)
    const [existing] = await db.select({ polygon: zones.polygon }).from(zones).where(and(eq(zones.id, c.req.param("zoneId")), eq(zones.cameraId, cam.id))).limit(1);
    if (!existing) return c.json({ error: "not found" }, 404);
    const gErr = validGeometry(patch.kind as string, existing.polygon);
    if (gErr) return c.json({ error: `existing points do not fit kind '${patch.kind}': ${gErr}` }, 400);
  }
  if (Object.keys(patch).length === 0) return c.json({ error: "nothing to update" }, 400);
  const [updated] = await db
    .update(zones)
    .set(patch)
    .where(and(eq(zones.id, c.req.param("zoneId")), eq(zones.cameraId, cam.id)))
    .returning();
  if (!updated) return c.json({ error: "not found" }, 404);
  await pushRulesIfRunning(cam, c.get("userId"));
  return c.json(updated);
});

zoneRoutes.delete("/:zoneId", async (c) => {
  const cam = await ownedCamera(c.get("userId"), c.req.param("cameraId"));
  if (!cam) return c.json({ error: "not found" }, 404);
  if (!UUID_RE.test(c.req.param("zoneId"))) return c.json({ error: "not found" }, 404);
  await db.delete(zones).where(and(eq(zones.id, c.req.param("zoneId")), eq(zones.cameraId, cam.id)));
  await pushRulesIfRunning(cam, c.get("userId"));
  return c.body(null, 204);
});

export const KNOWN_CLASSES = [
  "person", "bicycle", "car", "motorcycle", "bus", "truck",
  "cat", "dog", "backpack", "handbag", "suitcase",
];
const SEVERITIES = ["low", "medium", "high"];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const RULE_TYPES = ["presence", "tripwire", "dwell"];
const DIRECTIONS = ["in", "out", "both"];

async function zoneKind(cameraId: string, zoneId: string): Promise<string | null> {
  const [z] = await db.select({ kind: zones.kind }).from(zones).where(and(eq(zones.id, zoneId), eq(zones.cameraId, cameraId))).limit(1);
  return z?.kind ?? null;
}

// Validate the type-specific requirements. Returns an error string or null.
async function validateRuleType(cameraId: string, b: any): Promise<string | null> {
  const type = b.type ?? "presence";
  if (!RULE_TYPES.includes(type)) return "type must be presence|tripwire|dwell";
  if (type === "tripwire") {
    if (!b.zoneId) return "tripwire needs a line zone";
    if (await zoneKind(cameraId, b.zoneId) !== "line") return "tripwire needs a line-kind zone";
    if (!DIRECTIONS.includes(b.direction)) return "tripwire needs direction in|out|both";
  } else if (type === "dwell") {
    if (!b.zoneId) return "dwell needs a polygon zone";
    if (await zoneKind(cameraId, b.zoneId) !== "polygon") return "dwell needs a polygon-kind zone";
    if (typeof b.dwellSeconds !== "number" || b.dwellSeconds <= 0) return "dwell needs dwellSeconds > 0";
  }
  return null;
}

function validateRuleBody(b: any): string | null {
  if (!b?.name?.trim()) return "name required";
  if (!Array.isArray(b.classes) || b.classes.length < 1) return "classes must be a non-empty array";
  if (!b.classes.every((cl: any) => KNOWN_CLASSES.includes(cl))) return "unknown class";
  if (b.severity !== undefined && !SEVERITIES.includes(b.severity)) return "severity must be low|medium|high";
  for (const k of ["scheduleStart", "scheduleEnd"]) {
    if (b[k] !== undefined && b[k] !== null && !HHMM.test(b[k])) return `${k} must be HH:MM`;
  }
  if (b.minConfidence !== undefined && (typeof b.minConfidence !== "number" || b.minConfidence < 0 || b.minConfidence > 1)) return "minConfidence must be 0..1";
  if (b.enabled !== undefined && typeof b.enabled !== "boolean") return "enabled must be boolean";
  return null;
}

// A rule may only reference a zone that belongs to the same camera. UUID-guarded
// so a malformed id is a clean 400, not a Postgres cast error.
async function zoneBelongs(cameraId: string, zoneId: string): Promise<boolean> {
  if (!UUID_RE.test(zoneId)) return false;
  const [z] = await db
    .select({ id: zones.id })
    .from(zones)
    .where(and(eq(zones.id, zoneId), eq(zones.cameraId, cameraId)))
    .limit(1);
  return !!z;
}

// mounted at /cameras/:cameraId/rules
export const ruleRoutes = new Hono<{}, {}, "/cameras/:cameraId/rules">();
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
  if (b.zoneId && !(await zoneBelongs(cam.id, b.zoneId))) {
    return c.json({ error: "zone not found for this camera" }, 400);
  }
  const tErr = await validateRuleType(cam.id, b);
  if (tErr) return c.json({ error: tErr }, 400);
  const [rule] = await db.insert(rules).values({
    cameraId: cam.id,
    name: b.name.trim(),
    zoneId: b.zoneId || null,
    type: b.type ?? "presence",
    direction: b.direction ?? null,
    dwellSeconds: typeof b.dwellSeconds === "number" ? b.dwellSeconds : null,
    classes: b.classes,
    scheduleStart: b.scheduleStart ?? null,
    scheduleEnd: b.scheduleEnd ?? null,
    minConfidence: typeof b.minConfidence === "number" ? b.minConfidence : 0.4,
    severity: b.severity ?? "low",
    enabled: typeof b.enabled === "boolean" ? b.enabled : true,
  }).returning();
  await pushRulesIfRunning(cam, c.get("userId"));
  return c.json(rule, 201);
});

ruleRoutes.patch("/:ruleId", async (c) => {
  const cam = await ownedCamera(c.get("userId"), c.req.param("cameraId"));
  if (!cam) return c.json({ error: "not found" }, 404);
  if (!UUID_RE.test(c.req.param("ruleId"))) return c.json({ error: "not found" }, 404);
  const b = await c.req.json().catch(() => ({}));
  // validate only provided fields by merging onto a minimal valid base
  const merged = { name: b.name ?? "x", classes: b.classes ?? ["person"], severity: b.severity, scheduleStart: b.scheduleStart, scheduleEnd: b.scheduleEnd, minConfidence: b.minConfidence, enabled: b.enabled };
  const err = validateRuleBody(merged);
  if (err) return c.json({ error: err }, 400);
  // a patched zone must also belong to this camera (same rule as POST)
  if (b.zoneId && !(await zoneBelongs(cam.id, b.zoneId))) {
    return c.json({ error: "zone not found for this camera" }, 400);
  }
  const [cur] = await db.select().from(rules).where(and(eq(rules.id, c.req.param("ruleId")), eq(rules.cameraId, cam.id))).limit(1);
  if (!cur) return c.json({ error: "not found" }, 404);
  // Merge by KEY PRESENCE, not `??`: an explicit null (e.g. clearing a zone) must
  // be validated as the new value, else a tripwire could be PATCHed to zoneId:null,
  // pass validation against the old zone, and persist an invalid rule.
  const effective = {
    type: "type" in b ? b.type : cur.type,
    zoneId: "zoneId" in b ? b.zoneId : cur.zoneId,
    direction: "direction" in b ? b.direction : cur.direction,
    dwellSeconds: "dwellSeconds" in b ? b.dwellSeconds : cur.dwellSeconds,
  };
  const tErr = await validateRuleType(cam.id, effective);
  if (tErr) return c.json({ error: tErr }, 400);
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const k of ["name", "classes", "zoneId", "scheduleStart", "scheduleEnd", "minConfidence", "severity", "enabled", "type", "direction", "dwellSeconds"]) {
    if (b[k] !== undefined) patch[k === "name" ? "name" : k] = k === "name" ? String(b[k]).trim() : b[k];
  }
  // clearing the zone (null / "") normalizes to null; never store an empty string in a uuid column
  if ("zoneId" in patch && !patch.zoneId) patch.zoneId = null;
  const [updated] = await db.update(rules).set(patch).where(and(eq(rules.id, c.req.param("ruleId")), eq(rules.cameraId, cam.id))).returning();
  if (!updated) return c.json({ error: "not found" }, 404);
  await pushRulesIfRunning(cam, c.get("userId"));
  return c.json(updated);
});

ruleRoutes.delete("/:ruleId", async (c) => {
  const cam = await ownedCamera(c.get("userId"), c.req.param("cameraId"));
  if (!cam) return c.json({ error: "not found" }, 404);
  if (!UUID_RE.test(c.req.param("ruleId"))) return c.json({ error: "not found" }, 404);
  await db.delete(rules).where(and(eq(rules.id, c.req.param("ruleId")), eq(rules.cameraId, cam.id)));
  await pushRulesIfRunning(cam, c.get("userId"));
  return c.body(null, 204);
});

// Resolve a camera's ENABLED rules into self-contained payloads (zone polygon
// inlined) for delivery to the worker.
export type ResolvedRule = {
  id: string;
  type: string;
  classes: string[];
  zone: { x: number; y: number }[] | null;
  direction: string | null;
  dwell_seconds: number | null;
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
  return rows.map((r): ResolvedRule => ({
    id: r.id,
    type: r.type,
    classes: r.classes as string[],
    zone: (r.zonePolygon as { x: number; y: number }[] | null) ?? null,
    direction: r.direction,
    dwell_seconds: r.dwellSeconds,
    schedule: [r.scheduleStart, r.scheduleEnd],
    min_confidence: r.minConfidence,
    severity: r.severity,
    enabled: r.enabled,
  }))
  // Drop orphaned tracking rules: a tripwire/dwell whose zone was deleted resolves
  // with zone=null and can never match — don't push a dead (and worker-unsafe) rule.
  .filter((r) => !((r.type === "tripwire" || r.type === "dwell") && !r.zone));
}

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
