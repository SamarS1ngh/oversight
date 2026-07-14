import { test, expect, beforeAll } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../src/db";
import { cameras } from "../src/db/schema";

// DB-gated smoke test: cameras table now has lastSeenAt + notifyOnOffline columns.
// To run: DATABASE_URL=postgres://vms:vms_dev_pw@localhost:5432/vms bun test test/cameras.test.ts
// (Skips gracefully if Postgres is unreachable, so `bun test` still passes the unit suite without infra.)

let dbUp = false;
beforeAll(async () => {
  try {
    await db.execute(sql`select 1`);
    dbUp = true;
  } catch {
    dbUp = false;
  }
});

test("cameras carry lastSeenAt + notifyOnOffline", async () => {
  if (!dbUp) return;
  const rows = await db.select({ a: cameras.lastSeenAt, b: cameras.notifyOnOffline }).from(cameras).limit(1);
  expect(Array.isArray(rows)).toBe(true);
});
