/**
 * Seed script — populates the database with sample users and posts.
 *
 * Usage:
 *   bun run db:seed
 *
 * Uses auth.api.signUpEmail so each user gets a proper Account record
 * with a hashed password — ready to authenticate via the MCP server.
 */
import { ZenStackClient } from "@zenstackhq/orm";
import { BunSqliteDialect } from "kysely-bun-worker/normal";
import { auth } from "./auth";

import { schema } from "./zenstack/schema";

const dbPath = process.env.DB_PATH ?? "./dev.db";

const db = new ZenStackClient(schema, {
  // @ts-ignore
  dialect: new BunSqliteDialect({ url: dbPath }),
});

// Wipe existing data (cascade deletes accounts / sessions / posts)
await db.post.deleteMany({});
await db.user.deleteMany({});

const seedUsers = [
  { name: "Alice Martin", email: "alice@example.com", password: "alice1234" },
  { name: "Bob Dupont", email: "bob@example.com", password: "bob12345" },
  { name: "Carol Lemaire", email: "carol@example.com", password: "carol123" },
];

const createdIds: string[] = [];

for (const u of seedUsers) {
  const result = await auth.api.signUpEmail({ body: u });
  createdIds.push(result.user.id);
}

const posts = [
  {
    title: "Introduction to ZenStack",
    content: "ZenStack adds access-policy enforcement on top of Prisma ORM.",
    published: true,
    authorId: createdIds[0] as string,
  },
  {
    title: "Building an MCP server with Hono",
    content:
      "The MCP protocol lets AI agents interact with your database safely.",
    published: false,
    authorId: createdIds[0] as string,
  },
  {
    title: "Draft: better-auth deep dive",
    content: null,
    published: false,
    authorId: createdIds[1] as string,
  },
  {
    title: "Access policies in practice",
    content: "@@allow rules are evaluated at query time by the PolicyPlugin.",
    published: true,
    authorId: createdIds[2] as string,
  },
];

for (const post of posts) {
  await db.post.create({ data: post });
}

console.log(`Seeded ${seedUsers.length} users and ${posts.length} posts.\n`);
console.log("Credentials:");
for (const u of seedUsers) {
  console.log(`  ${u.email.padEnd(22)} password: ${u.password}`);
}
