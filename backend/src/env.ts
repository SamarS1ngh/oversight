// Central env access. Defaults are dev-friendly so the app and unit tests boot
// without a full environment; production values come from .env / compose.
export const env = {
  DATABASE_URL:
    process.env.DATABASE_URL ?? "postgres://vms:vms_dev_pw@localhost:5432/vms",
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
  JWT_SECRET: process.env.JWT_SECRET ?? "dev_secret_change_me",
  API_PORT: Number(process.env.API_PORT ?? 8080),
  WORKER_ID: process.env.WORKER_ID ?? "worker-1",
  RECORDINGS_DIR: process.env.RECORDINGS_DIR ?? "/recordings",
  RETENTION_DAYS: Number(process.env.RETENTION_DAYS ?? 7),
  MAX_STORAGE_GB: Number(process.env.MAX_STORAGE_GB ?? 10),
  APP_URL: process.env.APP_URL ?? "http://localhost:3000",
  VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY ?? "",
  VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY ?? "",
  VAPID_SUBJECT: process.env.VAPID_SUBJECT ?? "mailto:admin@example.com",
};
