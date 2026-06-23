import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { env } from "./env";
import { authRoutes } from "./auth/routes";
import { requireAuth } from "./auth/middleware";

const app = new Hono();
app.use("*", logger());
app.use("*", cors());

app.get("/health", (c) => c.json({ ok: true }));

app.route("/auth", authRoutes);

// Sanity-check protected route. Camera + alert routers mount here in later commits.
app.get("/me", requireAuth, (c) =>
  c.json({ id: c.get("userId"), username: c.get("username") }),
);

export default {
  port: env.API_PORT,
  fetch: app.fetch,
};
