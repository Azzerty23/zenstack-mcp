import { schema } from "./zenstack/schema";
import { BunSqliteDialect } from "kysely-bun-worker/normal";
import { ZenStackClient } from "@zenstackhq/orm";

const dbPath = process.env.DB_PATH ?? "./dev.db";

// ── ZenStack v3 ORM ───────────────────────────────────────────────────────────
// Pass the raw base client; policies are applied per-request
// in getClient() below via PolicyPlugin.
export const db = new ZenStackClient(schema, {
  dialect: new BunSqliteDialect({ url: dbPath }),
});
