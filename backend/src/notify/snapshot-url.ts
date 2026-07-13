import { env } from "../env";
import { signSnapshotToken } from "./snapshot-token";

export function snapshotUrl(alertId: string, nowMs: number): string {
  return `${env.APP_URL}/alerts/${alertId}/snapshot?token=${signSnapshotToken(alertId, nowMs)}`;
}
