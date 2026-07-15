import { test, expect, beforeAll } from "bun:test";
import { sql } from "drizzle-orm";
import { app } from "../src/app";
import { db } from "../src/db";

let dbUp = false;
beforeAll(async () => { try { await db.execute(sql`select 1`); dbUp = true; } catch { dbUp = false; } });
const call = (p: string, o: RequestInit = {}) => app.fetch(new Request(`http://test${p}`, o));
const json = (b: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
const rnd = () => Math.random().toString(36).slice(2, 9);
async function nuser() {
  const r = await call("/auth/signup", json({ username: "n_" + rnd(), password: "secret12" }));
  const { token } = await r.json();
  return (p: string, o: RequestInit = {}) => call(p, { ...o, headers: { ...(o.headers ?? {}), Authorization: `Bearer ${token}` } });
}

test("POST /discovery/scan requires auth", async () => {
  expect((await call("/discovery/scan", json({ username: "u", password: "p" }))).status).toBe(401);
});

test("POST /discovery/scan returns a scan_id for an authed caller", async () => {
  if (!dbUp) return;
  const a = await nuser();
  const res = await a("/discovery/scan", json({ username: "admin", password: "pw" }));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(typeof body.scan_id).toBe("string");
  expect(body.scan_id.length).toBeGreaterThan(10);
});

test("onDiscoveryResults relays to the requesting user's socket", () => {
  const { onDiscoveryResults } = require("../src/realtime/ingest");
  const sent: any[] = [];
  const fakeSend = (uid: string, payload: any) => { sent.push({ uid, payload }); };
  onDiscoveryResults({ user_id: "u1", scan_id: "s1", cameras: [{ ip: "1.2.3.4" }] }, fakeSend);
  expect(sent.length).toBe(1);
  expect(sent[0].uid).toBe("u1");
  expect(sent[0].payload.channel).toBe("discovery");
  expect(sent[0].payload.data.cameras[0].ip).toBe("1.2.3.4");
});

test("onDiscoveryResults ignores a message with no user_id", () => {
  const { onDiscoveryResults } = require("../src/realtime/ingest");
  const sent: any[] = [];
  onDiscoveryResults({ scan_id: "s1", cameras: [] }, (u, p) => sent.push({ u, p }));
  expect(sent.length).toBe(0);
});
