const RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

export function sevRank(s: string): number {
  return RANK[s] ?? 0;
}

// `channel` has minSeverity + cameraIds; `alert` is the detection event (snake_case).
export function shouldNotify(
  channel: { minSeverity: string; cameraIds: unknown },
  alert: { severity?: string; camera_id: string },
): boolean {
  if (sevRank(alert.severity ?? "low") < sevRank(channel.minSeverity)) return false;
  const cams = channel.cameraIds as string[] | null;
  if (cams != null && !cams.includes(alert.camera_id)) return false;
  return true;
}
