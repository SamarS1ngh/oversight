import { createHmac, timingSafeEqual } from "crypto";
import { env } from "../env";

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h

function mac(alertId: string, expMs: number): string {
  return createHmac("sha256", env.JWT_SECRET).update(`${alertId}.${expMs}`).digest("hex");
}

export function signSnapshotToken(alertId: string, nowMs: number, ttlMs = DEFAULT_TTL_MS): string {
  const exp = nowMs + ttlMs;
  return `${exp}.${mac(alertId, exp)}`;
}

export function verifySnapshotToken(alertId: string, token: string, nowMs: number): boolean {
  const dot = token.indexOf(".");
  if (dot < 0) return false;
  const exp = Number(token.slice(0, dot));
  const sig = token.slice(dot + 1);
  if (!Number.isFinite(exp) || exp < nowMs) return false;
  const expected = mac(alertId, exp);
  if (sig.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}
