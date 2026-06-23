import { app, websocket } from "./app";
import { env } from "./env";
import { startIngest } from "./realtime/ingest";

// Begin consuming worker events from Redis, then serve.
startIngest();

console.log(`[api] listening on :${env.API_PORT}`);

export default {
  port: env.API_PORT,
  fetch: app.fetch,
  websocket,
};
