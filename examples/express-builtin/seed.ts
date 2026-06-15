/**
 * Seed script — populates the database with sample users and posts.
 *
 * Usage:
 *   bun run db:seed
 */
import bcrypt from "bcryptjs";
import { ZenStackClient } from "@zenstackhq/orm";
import { BunSqliteDialect } from "kysely-bun-worker/normal";

import { schema } from "./zenstack/schema";

const dbPath = process.env.DB_PATH ?? "./dev.db";

const db = new ZenStackClient(schema, {
  dialect: new BunSqliteDialect({ url: dbPath }),
});

// Wipe existing data
await db.post.deleteMany({});
await db.user.deleteMany({});

const seedUsers = [
  { name: "Alice Martin", email: "alice@example.com", password: "alice1234" },
  { name: "Bob Dupont", email: "bob@example.com", password: "bob12345" },
  { name: "Carol Lemaire", email: "carol@example.com", password: "carol123" },
];

const createdIds: string[] = [];

for (const u of seedUsers) {
  const passwordHash = await bcrypt.hash(u.password, 10);
  const user = await db.user.create({
    data: { email: u.email, name: u.name, passwordHash },
  });
  createdIds.push(user.id);
}

const posts = [
  {
    title: "Introduction to ZenStack",
    content: "ZenStack adds access-policy enforcement on top of Prisma ORM.",
    published: true,
    authorId: createdIds[0] as string,
  },
  {
    title: "Building an MCP server with Express",
    content:
      "The MCP protocol lets AI agents interact with your database safely.",
    published: false,
    authorId: createdIds[0] as string,
  },
  {
    title: "Draft: built-in auth deep dive",
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
