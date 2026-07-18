import Redis from "ioredis";
import { env } from "../env";

// ioredis needs a dedicated connection for subscribe mode, so we keep the
// publisher and subscriber as separate clients. Offline queueing is on by
// default, so publishes issued before Redis is reachable are buffered.
export const redisPub = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});
export const redisSub = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

redisPub.on("error", (e) => console.error("[redis:pub]", e.message));
redisSub.on("error", (e) => console.error("[redis:sub]", e.message));

// Dedicated connection for blocking XREADGROUP (can't share the subscribe-mode sub).
export const redisStream = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
redisStream.on("error", (e) => console.error("[redis:stream]", e.message));
