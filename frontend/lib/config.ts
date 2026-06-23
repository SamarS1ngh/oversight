// Browser-side endpoints. Defaults match local docker-compose (the browser runs
// on the host, so it reaches the API on localhost:8080). For a remote deploy,
// set NEXT_PUBLIC_API_URL / NEXT_PUBLIC_WS_URL at build time.
export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";
export const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080/ws";
export const STUN_URL =
  process.env.NEXT_PUBLIC_STUN_URL ?? "stun:stun.l.google.com:19302";
