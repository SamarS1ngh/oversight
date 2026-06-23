import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env";
import * as schema from "./schema";

// postgres-js connects lazily on first query, so importing this module does not
// require a live database (keeps /health and unit tests cheap).
export const client = postgres(env.DATABASE_URL);
export const db = drizzle(client, { schema });
