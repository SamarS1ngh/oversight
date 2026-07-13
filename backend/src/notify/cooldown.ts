// In-memory last-send time per "channelId:cameraId". Best-effort rate limit that
// resets on API restart — good enough to stop phone spam from a busy scene.
const last = new Map<string, number>();

export function allow(key: string, nowMs: number, cooldownSecs: number): boolean {
  if (cooldownSecs <= 0) return true;
  const prev = last.get(key);
  if (prev !== undefined && nowMs - prev < cooldownSecs * 1000) return false;
  last.set(key, nowMs);
  return true;
}

export function _reset(): void {
  last.clear();
}
