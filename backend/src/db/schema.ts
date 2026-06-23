import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  integer,
  real,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const cameras = pgTable("cameras", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  rtspUrl: text("rtsp_url").notNull(),
  location: text("location"),
  enabled: boolean("enabled").notNull().default(true),
  // last known runtime state, mirrors the worker: stopped|connecting|live|error
  status: text("status").notNull().default("stopped"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Mirrors the detection event in docs/EVENT_FORMAT.md. `id` is the
// worker-generated UUID, used as an idempotency key on insert.
export const alerts = pgTable(
  "alerts",
  {
    id: uuid("id").primaryKey(),
    cameraId: uuid("camera_id")
      .notNull()
      .references(() => cameras.id, { onDelete: "cascade" }),
    type: text("type").notNull().default("person_detected"),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    confidence: real("confidence").notNull(),
    count: integer("count").notNull(),
    bboxes: jsonb("bboxes"),
    frameW: integer("frame_w"),
    frameH: integer("frame_h"),
    workerId: text("worker_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // primary query path: alerts for a camera within a time range, newest first
    cameraTsIdx: index("alerts_camera_ts_idx").on(t.cameraId, t.ts),
  }),
);

export type User = typeof users.$inferSelect;
export type Camera = typeof cameras.$inferSelect;
export type Alert = typeof alerts.$inferSelect;
