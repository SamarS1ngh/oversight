import { asc, eq } from "drizzle-orm";
import { promises as fs } from "fs";
import { join } from "path";
import { db } from "../db";
import { clips } from "../db/schema";
import { env } from "../env";

export type ClipRow = {
  id: string;
  path: string;
  thumbPath: string | null;
  sizeBytes: number;
  createdAt: Date | string;
};

const DAY_MS = 86_400_000;

// Pure: which clips are older than the retention window.
export function selectExpired(rows: ClipRow[], nowMs: number, retentionDays: number): ClipRow[] {
  const cutoff = nowMs - retentionDays * DAY_MS;
  return rows.filter((r) => new Date(r.createdAt).getTime() < cutoff);
}

// Pure: from oldest-first rows, which to drop so the total stays <= maxBytes.
export function selectOverCap(rowsOldestFirst: ClipRow[], maxBytes: number): ClipRow[] {
  let total = rowsOldestFirst.reduce((s, r) => s + r.sizeBytes, 0);
  const out: ClipRow[] = [];
  for (const r of rowsOldestFirst) {
    if (total <= maxBytes) break;
    out.push(r);
    total -= r.sizeBytes;
  }
  return out;
}

async function deleteClip(r: ClipRow): Promise<void> {
  await fs.rm(join(env.RECORDINGS_DIR, r.path), { force: true }).catch(() => {});
  if (r.thumbPath) {
    await fs.rm(join(env.RECORDINGS_DIR, r.thumbPath), { force: true }).catch(() => {});
  }
  await db.delete(clips).where(eq(clips.id, r.id));
}

// Delete expired clips, then evict oldest until under the size cap. Returns count.
export async function runRetentionOnce(nowMs = Date.now()): Promise<number> {
  const rows = (await db
    .select({
      id: clips.id,
      path: clips.path,
      thumbPath: clips.thumbPath,
      sizeBytes: clips.sizeBytes,
      createdAt: clips.createdAt,
    })
    .from(clips)
    .orderBy(asc(clips.createdAt))) as ClipRow[];

  const expired = selectExpired(rows, nowMs, env.RETENTION_DAYS);
  const expiredIds = new Set(expired.map((r) => r.id));
  const remaining = rows.filter((r) => !expiredIds.has(r.id));
  const over = selectOverCap(remaining, env.MAX_STORAGE_GB * 1024 ** 3);

  const toDelete = [...expired, ...over];
  for (const r of toDelete) await deleteClip(r);
  return toDelete.length;
}

export function startRetention(): void {
  const run = () =>
    void runRetentionOnce().catch((e) =>
      console.error("[retention]", (e as Error).message),
    );
  run(); // once on boot
  setInterval(run, 5 * 60 * 1000);
  console.log("[retention] pruner started (age + size)");
}
