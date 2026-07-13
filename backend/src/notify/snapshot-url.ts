import { env } from "../env";
import { signSnapshotToken } from "./snapshot-token";

export function snapshotUrl(alertId: string, nowMs: number): string {
  return `${env.PUBLIC_API_URL}/alerts/${alertId}/snapshot?token=${signSnapshotToken(alertId, nowMs)}`;
}

// Trust boundary guard: the worker is the only producer of snapshot_path, and it
// always emits this exact shape. Anything else (e.g. a `../`-laden value) is
// rejected rather than persisted, so dispatch/retry/route can never be tricked
// into reading an arbitrary file off disk.
const SNAP_RE = /^snapshots\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.jpg$/;
export function safeSnapshotPath(v: unknown): string | null {
  return typeof v === "string" && SNAP_RE.test(v) ? v : null;
}
