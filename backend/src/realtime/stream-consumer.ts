import { redisStream } from "./redis";
import { onDetection, onClip } from "./ingest";
import { env } from "../env";

export const STREAM_GROUP = "vms-backend";
export const STREAM_CONSUMER = "backend";
const STREAMS = ["stream:detections", "stream:clips"] as const;

export async function ensureGroups(): Promise<void> {
  for (const key of STREAMS) {
    try {
      await redisStream.xgroup("CREATE", key, STREAM_GROUP, "$", "MKSTREAM");
    } catch (e: any) {
      if (!String(e?.message ?? "").includes("BUSYGROUP")) throw e;
    }
  }
}

// ioredis returns entry fields as a flat [name, value, name, value, ...] array.
function fieldValue(fields: string[], name: string): string | null {
  const i = fields.indexOf(name);
  return i >= 0 && i + 1 < fields.length ? fields[i + 1] : null;
}

async function process(stream: string, fields: string[]): Promise<void> {
  const raw = fieldValue(fields, "data");
  if (raw == null) return; // nothing to process; caller will ACK
  const msg = JSON.parse(raw); // throws on malformed -> caller leaves it pending
  if (stream === "stream:detections") await onDetection(msg);
  else if (stream === "stream:clips") await onClip(msg);
}

// One read of NEW entries (>) across the streams; process + XACK each; on
// failure leave pending (reclaimStale retries/poison-drops).
export async function consumeOnce(blockMs = env.STREAM_BLOCK_MS): Promise<number> {
  const res = (await redisStream.xreadgroup(
    "GROUP", STREAM_GROUP, STREAM_CONSUMER, "COUNT", 50, "BLOCK", blockMs,
    "STREAMS", ...STREAMS, ...STREAMS.map(() => ">"),
  )) as [string, [string, string[]][]][] | null;
  if (!res) return 0;
  let n = 0;
  for (const [stream, entries] of res) {
    for (const [id, fields] of entries) {
      try {
        await process(stream, fields);
        await redisStream.xack(stream, STREAM_GROUP, id);
        n++;
      } catch (e) {
        console.error(`[stream] process failed ${stream} ${id}:`, (e as Error).message);
        // leave pending -> reclaimStale retries; poison-drops after MAX_DELIVERIES
      }
    }
  }
  return n;
}

// Retry this consumer's delivered-but-unacked entries idle > idleMs; drop a
// poison entry after maxDeliveries.
export async function reclaimStale(
  idleMs = env.RECLAIM_IDLE_MS, maxDeliveries = env.MAX_DELIVERIES,
): Promise<void> {
  for (const stream of STREAMS) {
    const res = (await redisStream.xautoclaim(
      stream, STREAM_GROUP, STREAM_CONSUMER, idleMs, "0-0", "COUNT", 50,
    )) as [string, [string, string[]][], string[]] | null;
    const entries = res?.[1] ?? [];
    for (const [id, fields] of entries) {
      try {
        await process(stream, fields);
        await redisStream.xack(stream, STREAM_GROUP, id);
      } catch (e) {
        const pend = (await redisStream.xpending(
          stream, STREAM_GROUP, "IDLE", 0, id, id, 1,
        )) as [string, string, number, number][] | null;
        const deliveries = Number(pend?.[0]?.[3] ?? 0);
        if (deliveries >= maxDeliveries) {
          console.error(`[stream] poison drop ${stream} ${id} after ${deliveries} deliveries`);
          await redisStream.xack(stream, STREAM_GROUP, id);
        }
      }
    }
  }
}

// Boot-time loop: reclaim, then read new, forever. Never throws out.
export async function startStreamConsumer(): Promise<void> {
  await ensureGroups();
  console.log("[stream] consumer started");
  for (;;) {
    try {
      await reclaimStale();
      await consumeOnce();
    } catch (e) {
      const msg = (e as Error).message;
      console.error("[stream] loop error:", msg);
      if (msg.includes("NOGROUP")) await ensureGroups().catch(() => {});
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
