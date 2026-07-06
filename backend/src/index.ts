import { app, websocket } from "./app";
import { env } from "./env";
import { startIngest } from "./realtime/ingest";
import { startRetention } from "./realtime/retention";

// Begin consuming worker events from Redis, then serve.
//  That's why startIngest() (Redis subscribe) lives in index.ts, not app.ts — so importing the app for tests doesn't accidentally open Redis connections.
startIngest();
startRetention();

console.log(`[api] listening on :${env.API_PORT}`);

export default {
  port: env.API_PORT,
  fetch: app.fetch,
  websocket,
};
