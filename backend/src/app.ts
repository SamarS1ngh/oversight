import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { createBunWebSocket } from "hono/bun";
import { authRoutes } from "./auth/routes";
import { cameraRoutes } from "./cameras/routes";
import { alertRoutes } from "./alerts/routes";
import { requireAuth } from "./auth/middleware";
import { verifyToken } from "./auth/jwt";
import { addConn, removeConn } from "./realtime/connections";

const { upgradeWebSocket, websocket } = createBunWebSocket();

// The app graph with no side effects on import (no server listen, no Redis
// subscribe), so tests can drive it via app.fetch(...) in-process.
export const app = new Hono();
app.use("*", logger());
app.use("*", cors());

app.get("/health", (c) => c.json({ ok: true }));
app.route("/auth", authRoutes);
app.route("/cameras", cameraRoutes);
app.route("/alerts", alertRoutes);

app.get("/me", requireAuth, (c) =>
  c.json({ id: c.get("userId"), username: c.get("username") }),
);

app.get(
  "/ws",
  upgradeWebSocket((c) => {
    const token = c.req.query("token");
    let userId: string | null = null;
    return {
      async onOpen(_evt, ws) {
        try {
          if (!token) throw new Error("missing token");
          const payload = await verifyToken(token);
          userId = payload.sub;
          addConn(userId, ws);
          ws.send(
            JSON.stringify({ channel: "state", data: { type: "ws_ready" } }),
          );
        } catch {
          ws.close(1008, "unauthorized");
        }
      },
      onClose(_evt, ws) {
        if (userId) removeConn(userId, ws);
      },
    };
  }),
);

export { websocket };
