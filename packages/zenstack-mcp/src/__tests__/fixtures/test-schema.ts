import { ExpressionUtils, type SchemaDef } from "@zenstackhq/schema";

/**
 * Handcrafted minimal SchemaDef mirroring the shape emitted by `zenstack
 * generate` (see examples/express-builtin/zenstack/schema.ts). Exercises the
 * surfaces the query schema factory cares about: scalar types, an enum, an
 * optional field, a relation pair, a compound @@unique, and a procedure.
 */
export const testSchema = {
  provider: { type: "sqlite" },
  models: {
    User: {
      name: "User",
      fields: {
        id: { name: "id", type: "String", id: true, default: ExpressionUtils.call("cuid") },
        email: { name: "email", type: "String", unique: true },
        name: { name: "name", type: "String", optional: true },
        role: { name: "role", type: "Role", default: "USER" },
        posts: {
          name: "posts",
          type: "Post",
          array: true,
          relation: { opposite: "author" },
        },
      },
      idFields: ["id"],
      uniqueFields: {
        id: { type: "String" },
        email: { type: "String" },
      },
    },
    Post: {
      name: "Post",
      fields: {
        id: { name: "id", type: "String", id: true, default: ExpressionUtils.call("cuid") },
        title: { name: "title", type: "String" },
        views: { name: "views", type: "Int", default: 0 },
        published: { name: "published", type: "Boolean", default: false },
        author: {
          name: "author",
          type: "User",
          relation: { opposite: "posts", fields: ["authorId"], references: ["id"] },
        },
        authorId: { name: "authorId", type: "String", foreignKeyFor: ["author"] },
      },
      idFields: ["id"],
      uniqueFields: {
        id: { type: "String" },
        title_authorId: { title: { type: "String" }, authorId: { type: "String" } },
      },
    },
  },
  enums: {
    Role: { name: "Role", values: { USER: "USER", ADMIN: "ADMIN" } },
  },
  plugins: {},
  procedures: {
    greet: {
      params: { name: { name: "name", type: "String" } },
      returnType: "String",
    },
    checkout: {
      params: {
        cartId: { name: "cartId", type: "String" },
        coupon: { name: "coupon", type: "String", optional: true },
      },
      returnType: "String",
      mutation: true,
    },
  },
} as const satisfies SchemaDef;
