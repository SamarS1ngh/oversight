import { Hono } from "hono";
import { requireAuth } from "../auth/middleware";
import { publishCommand } from "../realtime/channels";

export const discoveryRoutes = new Hono();
discoveryRoutes.use("*", requireAuth);

const SCAN_COOLDOWN_MS = 10_000;
const lastScanAt = new Map<string, number>();

discoveryRoutes.post("/scan", async (c) => {
  const userId = c.get("userId");
  const now = Date.now();
  const prev = lastScanAt.get(userId) ?? 0;
  if (now - prev < SCAN_COOLDOWN_MS) {
    return c.json({ error: "scan already in progress; try again shortly" }, 429);
  }
  lastScanAt.set(userId, now);
  const b = await c.req.json().catch(() => ({}));
  const username = typeof b?.username === "string" ? b.username : "";
  const password = typeof b?.password === "string" ? b.password : "";
  const scanId = crypto.randomUUID();
  await publishCommand({
    type: "discover", scan_id: scanId, user_id: userId,
    username, password, ts: new Date().toISOString(),
  });
  return c.json({ scan_id: scanId });
});
