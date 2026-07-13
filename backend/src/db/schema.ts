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
    label: text("label"),
    ruleId: uuid("rule_id"),
    severity: text("severity").notNull().default("low"),
    snapshotPath: text("snapshot_path"),
    status: text("status").notNull().default("new"),
    ackedAt: timestamp("acked_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // primary query path: alerts for a camera within a time range, newest first
    cameraTsIdx: index("alerts_camera_ts_idx").on(t.cameraId, t.ts),
  }),
);

// One recorded event-clip. `id` is the worker-generated UUID (idempotency key),
// matching the clip_ready event in docs/EVENT_FORMAT.md.
export const clips = pgTable(
  "clips",
  {
    id: uuid("id").primaryKey(),
    cameraId: uuid("camera_id")
      .notNull()
      .references(() => cameras.id, { onDelete: "cascade" }),
    // links to the detection/alert that triggered the clip; nullable so a clip
    // survives its alert being deleted, and so ingest can still store a clip if
    // the alert row hasn't landed yet.
    alertId: uuid("alert_id").references(() => alerts.id, {
      onDelete: "set null",
    }),
    backend: text("backend").notNull().default("local"),
    path: text("path").notNull(), // relative to RECORDINGS_DIR
    thumbPath: text("thumb_path"),
    startTs: timestamp("start_ts", { withTimezone: true }).notNull(),
    endTs: timestamp("end_ts", { withTimezone: true }).notNull(),
    durationMs: integer("duration_ms").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    cameraStartIdx: index("clips_camera_start_idx").on(t.cameraId, t.startTs),
  }),
);

// A drawn region of interest on a camera. `polygon` is normalized [0,1] points.
export const zones = pgTable(
  "zones",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cameraId: uuid("camera_id")
      .notNull()
      .references(() => cameras.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    polygon: jsonb("polygon").notNull(), // [{ x:0.1, y:0.2 }, ...] normalized, >=3 pts
    kind: text("kind").notNull().default("polygon"), // 'polygon' | 'line'
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({ cameraIdx: index("zones_camera_idx").on(t.cameraId) }),
);

// An alerting rule. Matches when a detected object of one of `classes`, above
// `minConfidence`, (inside `zoneId` if set) fires during the schedule window.
export const rules = pgTable(
  "rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cameraId: uuid("camera_id")
      .notNull()
      .references(() => cameras.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    zoneId: uuid("zone_id").references(() => zones.id, { onDelete: "set null" }),
    type: text("type").notNull().default("presence"), // 'presence' | 'tripwire' | 'dwell'
    direction: text("direction"), // 'in' | 'out' | 'both' (tripwire only)
    dwellSeconds: integer("dwell_seconds"), // dwell only
    classes: jsonb("classes").notNull(), // ["person","car"]
    scheduleStart: text("schedule_start"), // "HH:MM" local, nullable
    scheduleEnd: text("schedule_end"),
    minConfidence: real("min_confidence").notNull().default(0.4),
    severity: text("severity").notNull().default("low"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({ cameraIdx: index("rules_camera_idx").on(t.cameraId) }),
);

// A user's notification destination (webhook / ntfy / telegram). Config holds the
// per-type target + secrets. See docs/superpowers/specs M3a.
export const notificationChannels = pgTable(
  "notification_channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(), // 'webhook' | 'ntfy' | 'telegram' | 'pushover' | 'webpush'
    name: text("name").notNull(),
    config: jsonb("config").notNull(),
    minSeverity: text("min_severity").notNull().default("low"),
    cameraIds: jsonb("camera_ids"), // string[] | null (null = all)
    cooldownSecs: integer("cooldown_secs").notNull().default(60),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({ userIdx: index("notification_channels_user_idx").on(t.userId) }),
);

// A failed notification send, persisted for background retry (M3b). Only
// failures land here — the happy path sends inline and writes nothing.
export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => notificationChannels.id, { onDelete: "cascade" }),
    alertId: uuid("alert_id"), // null for a synthetic /test send
    payload: jsonb("payload").notNull(), // render inputs to rebuild the send
    attempts: integer("attempts").notNull().default(1),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("pending"), // pending | sent | dead
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ dueIdx: index("notification_deliveries_due_idx").on(t.status, t.nextAttemptAt) }),
);

export type User = typeof users.$inferSelect;
export type Camera = typeof cameras.$inferSelect;
export type Alert = typeof alerts.$inferSelect;
export type Clip = typeof clips.$inferSelect;
export type Zone = typeof zones.$inferSelect;
export type Rule = typeof rules.$inferSelect;
export type NotifChannel = typeof notificationChannels.$inferSelect;
export type NotifDelivery = typeof notificationDeliveries.$inferSelect;
