import { ZenStackClient } from "@zenstackhq/orm";
import { BunSqliteDialect } from "kysely-bun-worker/normal";
import { schema } from "./zenstack/schema";

const dbPath = process.env.DB_PATH ?? "./dev.db";

export const db = new ZenStackClient(schema, {
  dialect: new BunSqliteDialect({ url: dbPath }),
});
