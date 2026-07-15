import { Hono } from "hono";
import { requireAuth } from "../auth/middleware";
import { publishCommand } from "../realtime/channels";

export const discoveryRoutes = new Hono();
discoveryRoutes.use("*", requireAuth);

discoveryRoutes.post("/scan", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const username = typeof b?.username === "string" ? b.username : "";
  const password = typeof b?.password === "string" ? b.password : "";
  const scanId = crypto.randomUUID();
  await publishCommand({
    type: "discover", scan_id: scanId, user_id: c.get("userId"),
    username, password, ts: new Date().toISOString(),
  });
  return c.json({ scan_id: scanId });
});
