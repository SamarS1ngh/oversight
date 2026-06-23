import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";
import { signToken } from "./jwt";

export const authRoutes = new Hono();

authRoutes.post("/signup", async (c) => {
  const body = await c.req.json().catch(() => null);
  const username = body?.username?.trim();
  const password = body?.password;
  if (!username || !password || password.length < 6) {
    return c.json(
      { error: "username and password (min 6 chars) required" },
      400,
    );
  }

  const existing = await db
    .select()
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  if (existing.length) return c.json({ error: "username taken" }, 409);

  const passwordHash = await Bun.password.hash(password);
  const [u] = await db
    .insert(users)
    .values({ username, passwordHash })
    .returning();
  const token = await signToken(u.id, u.username);
  return c.json({ token, user: { id: u.id, username: u.username } }, 201);
});

authRoutes.post("/login", async (c) => {
  const body = await c.req.json().catch(() => null);
  const username = body?.username?.trim();
  const password = body?.password;
  if (!username || !password) {
    return c.json({ error: "username and password required" }, 400);
  }

  const [u] = await db
    .select()
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  if (!u || !(await Bun.password.verify(password, u.passwordHash))) {
    return c.json({ error: "invalid credentials" }, 401);
  }

  const token = await signToken(u.id, u.username);
  return c.json({ token, user: { id: u.id, username: u.username } });
});
