import type { Context, Next } from "hono";
import { verifyToken } from "./jwt";

// Expose the authenticated identity to downstream handlers via c.get(...).
declare module "hono" {
  interface ContextVariableMap {
    userId: string;
    username: string;
  }
}

export async function requireAuth(c: Context, next: Next) {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "missing or malformed Authorization header" }, 401);
  }
  try {
    const payload = await verifyToken(header.slice(7));
    c.set("userId", payload.sub);
    c.set("username", payload.username);
    await next();
  } catch {
    return c.json({ error: "invalid or expired token" }, 401);
  }
}
