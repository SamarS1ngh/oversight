import { test, expect } from "bun:test";
import { signToken, verifyToken } from "../src/auth/jwt";

// Pure unit tests — no DB / Redis needed.

test("sign + verify roundtrip preserves identity", async () => {
  const token = await signToken("user-1", "alice");
  const payload = await verifyToken(token);
  expect(payload.sub).toBe("user-1");
  expect(payload.username).toBe("alice");
  expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
});

test("tampered token fails verification", async () => {
  const token = await signToken("user-1", "alice");
  const tampered = token.slice(0, -3) + (token.endsWith("a") ? "bbb" : "aaa");
  await expect(verifyToken(tampered)).rejects.toBeDefined();
});
