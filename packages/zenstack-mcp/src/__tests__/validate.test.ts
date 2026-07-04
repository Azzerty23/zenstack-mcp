import { describe, test, expect } from "bun:test";
import { createQuerySchemaFactory } from "@zenstackhq/orm";
import { validateOperation, type QuerySchemaFactory } from "../tools/validate.js";
import { ALL_OPERATIONS } from "../types.js";
import type { McpModelDef } from "../types.js";
import { testSchema } from "./fixtures/test-schema.js";

// The real ORM factory — these tests exercise actual schema semantics, not a mock.
const factory = createQuerySchemaFactory(testSchema) as unknown as QuerySchemaFactory;

const USER_FIELDS: McpModelDef["fields"] = [
  { name: "id",    type: "String", isId: true,  isUnique: false, isRequired: true,  isList: false, isRelation: false },
  { name: "email", type: "String", isId: false, isUnique: true,  isRequired: true,  isList: false, isRelation: false },
  { name: "name",  type: "String", isId: false, isUnique: false, isRequired: false, isList: false, isRelation: false },
];

const USER_MODEL: McpModelDef = {
  name: "User",
  dbName: "user",
  operations: [...ALL_OPERATIONS],
  fields: USER_FIELDS,
};

const POST_MODEL: McpModelDef = {
  name: "Post",
  dbName: "post",
  operations: ["findMany", "findUnique", "create"],
  fields: [
    { name: "id",    type: "String", isId: true,  isUnique: false, isRequired: true, isList: false, isRelation: false },
    { name: "title", type: "String", isId: false, isUnique: false, isRequired: true, isList: false, isRelation: false },
  ],
};

const MODELS = [USER_MODEL, POST_MODEL];

describe("validateOperation — model/operation guards", () => {
  test("returns error for unknown model", () => {
    const result = validateOperation(MODELS, "Comment", "findMany", {}, factory);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors[0]).toContain("Unknown model");
  });

  test("returns error for operation not in model's allowlist", () => {
    const result = validateOperation(MODELS, "Post", "delete", { where: { id: "1" } }, factory);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors[0]).toContain(`Operation "delete" not available`);
  });

  test("passes for valid model and allowed operation", () => {
    const result = validateOperation(MODELS, "Post", "findMany", {}, factory);
    expect(result.valid).toBe(true);
  });
});

describe("validateOperation — arg structure validation", () => {
  test("findUnique requires where", () => {
    const result = validateOperation(MODELS, "User", "findUnique", {}, factory);
    expect(result.valid).toBe(false);
  });

  test("findUnique passes with where", () => {
    const result = validateOperation(MODELS, "User", "findUnique", { where: { id: "1" } }, factory);
    expect(result.valid).toBe(true);
  });

  test("create requires data", () => {
    const result = validateOperation(MODELS, "User", "create", {}, factory);
    expect(result.valid).toBe(false);
  });

  test("create passes with data", () => {
    const result = validateOperation(MODELS, "User", "create", { data: { email: "a@b.com" } }, factory);
    expect(result.valid).toBe(true);
  });

  test("create rejects data missing a required field", () => {
    const result = validateOperation(MODELS, "User", "create", { data: { name: "Alice" } }, factory);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.includes("data"))).toBe(true);
  });

  test("update requires where and data", () => {
    const result = validateOperation(MODELS, "User", "update", {}, factory);
    expect(result.valid).toBe(false);
  });

  test("update passes with where and data", () => {
    const result = validateOperation(MODELS, "User", "update", { where: { id: "1" }, data: { name: "Alice" } }, factory);
    expect(result.valid).toBe(true);
  });

  test("delete requires where", () => {
    const result = validateOperation(MODELS, "User", "delete", {}, factory);
    expect(result.valid).toBe(false);
  });

  test("findMany passes without args", () => {
    const result = validateOperation(MODELS, "User", "findMany", {}, factory);
    expect(result.valid).toBe(true);
  });

  test("findMany passes with pagination args", () => {
    const result = validateOperation(MODELS, "User", "findMany", { skip: 0, take: 10 }, factory);
    expect(result.valid).toBe(true);
  });

  test("findMany rejects non-integer skip", () => {
    const result = validateOperation(MODELS, "User", "findMany", { skip: 1.5 }, factory);
    expect(result.valid).toBe(false);
  });

  test("createMany requires data array or object per ORM semantics", () => {
    const result = validateOperation(MODELS, "User", "createMany", { data: [{ email: "a@b.com" }] }, factory);
    expect(result.valid).toBe(true);
  });

  test("rejects unknown top-level keys (strict args)", () => {
    const result = validateOperation(MODELS, "User", "findMany", { wherex: { id: "1" } }, factory);
    expect(result.valid).toBe(false);
  });
});

describe("validateOperation — unique where (update / delete / upsert / findUnique)", () => {
  test("findUnique accepts @unique field (email)", () => {
    const result = validateOperation(MODELS, "User", "findUnique", { where: { email: "a@b.com" } }, factory);
    expect(result.valid).toBe(true);
  });

  test("update rejects non-unique where field alone", () => {
    const result = validateOperation(MODELS, "User", "update", { where: { name: "Alice" }, data: { name: "Bob" } }, factory);
    expect(result.valid).toBe(false);
  });

  test("update accepts @unique field in where", () => {
    const result = validateOperation(MODELS, "User", "update", { where: { email: "a@b.com" }, data: { name: "Alice" } }, factory);
    expect(result.valid).toBe(true);
  });

  test("delete rejects non-unique where field alone", () => {
    const result = validateOperation(MODELS, "User", "delete", { where: { name: "Alice" } }, factory);
    expect(result.valid).toBe(false);
  });

  test("upsert rejects empty where", () => {
    const result = validateOperation(
      MODELS, "User", "upsert",
      { where: {}, create: { email: "a@b.com" }, update: { name: "Alice" } },
      factory,
    );
    expect(result.valid).toBe(false);
  });

  test("upsert accepts @unique field in where", () => {
    const result = validateOperation(
      MODELS, "User", "upsert",
      { where: { email: "a@b.com" }, create: { email: "a@b.com" }, update: { name: "Alice" } },
      factory,
    );
    expect(result.valid).toBe(true);
  });

  test("compound @@unique is accepted in findUnique where", () => {
    const result = validateOperation(
      MODELS, "Post", "findUnique",
      { where: { title_authorId: { title: "Hello", authorId: "u1" } } },
      factory,
    );
    expect(result.valid).toBe(true);
  });
});

describe("validateOperation — requireWhereForBulk", () => {
  test("rejects deleteMany without where when requireWhereForBulk", () => {
    const result = validateOperation(MODELS, "User", "deleteMany", {}, factory, { requireWhereForBulk: true });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors[0]).toContain("requireWhereForBulk");
  });

  test("rejects deleteMany with empty where when requireWhereForBulk", () => {
    const result = validateOperation(MODELS, "User", "deleteMany", { where: {} }, factory, { requireWhereForBulk: true });
    expect(result.valid).toBe(false);
  });

  test("passes deleteMany with non-empty where", () => {
    const result = validateOperation(MODELS, "User", "deleteMany", { where: { id: "1" } }, factory, { requireWhereForBulk: true });
    expect(result.valid).toBe(true);
  });

  test("rejects updateMany without where when requireWhereForBulk", () => {
    const result = validateOperation(MODELS, "User", "updateMany", { data: { name: "X" } }, factory, { requireWhereForBulk: true });
    expect(result.valid).toBe(false);
  });

  test("passes deleteMany without where when requireWhereForBulk is false", () => {
    const result = validateOperation(MODELS, "User", "deleteMany", {}, factory, { requireWhereForBulk: false });
    expect(result.valid).toBe(true);
  });
});

describe("validateOperation — where field type & enum validation", () => {
  test("findMany rejects wrong type for String field in where", () => {
    const result = validateOperation(MODELS, "User", "findMany", { where: { id: 123 } }, factory);
    expect(result.valid).toBe(false);
  });

  test("findUnique accepts correct type for String id", () => {
    const result = validateOperation(MODELS, "User", "findUnique", { where: { id: "abc" } }, factory);
    expect(result.valid).toBe(true);
  });

  test("enum field accepts a valid member in where", () => {
    const result = validateOperation(MODELS, "User", "findMany", { where: { role: "ADMIN" } }, factory);
    expect(result.valid).toBe(true);
  });

  test("enum field rejects an invalid member in where", () => {
    const result = validateOperation(MODELS, "User", "findMany", { where: { role: "SUPERADMIN" } }, factory);
    expect(result.valid).toBe(false);
  });

  test("enum field rejects an invalid member in create data", () => {
    const result = validateOperation(MODELS, "User", "create", { data: { email: "a@b.com", role: "NOPE" } }, factory);
    expect(result.valid).toBe(false);
  });
});

describe("validateOperation — relations (filters, nested writes, select/include)", () => {
  test("relation filter (some) is accepted", () => {
    const result = validateOperation(
      MODELS, "User", "findMany",
      { where: { posts: { some: { title: { contains: "hello" } } } } },
      factory,
    );
    expect(result.valid).toBe(true);
  });

  test("invalid relation filter operator is rejected", () => {
    const result = validateOperation(
      MODELS, "User", "findMany",
      { where: { posts: { anyOf: { title: "x" } } } },
      factory,
    );
    expect(result.valid).toBe(false);
  });

  test("nested create through relation is accepted", () => {
    const result = validateOperation(
      MODELS, "User", "create",
      { data: { email: "a@b.com", posts: { create: [{ title: "Hi" }] } } },
      factory,
    );
    expect(result.valid).toBe(true);
  });

  test("select with a valid field is accepted", () => {
    const result = validateOperation(MODELS, "User", "findMany", { select: { email: true } }, factory);
    expect(result.valid).toBe(true);
  });

  test("select with an unknown field is rejected", () => {
    const result = validateOperation(MODELS, "User", "findMany", { select: { doesNotExist: true } }, factory);
    expect(result.valid).toBe(false);
  });

  test("include with a valid relation is accepted", () => {
    const result = validateOperation(MODELS, "User", "findMany", { include: { posts: true } }, factory);
    expect(result.valid).toBe(true);
  });

  test("include with a non-relation field is rejected", () => {
    const result = validateOperation(MODELS, "User", "findMany", { include: { email: true } }, factory);
    expect(result.valid).toBe(false);
  });

  test("relationDepth 0 rejects relation includes", () => {
    const result = validateOperation(
      MODELS, "User", "findMany",
      { include: { posts: true } },
      factory,
      { relationDepth: 0 },
    );
    expect(result.valid).toBe(false);
  });

  test("relationDepth 1 allows one level of include", () => {
    const result = validateOperation(
      MODELS, "User", "findMany",
      { include: { posts: true } },
      factory,
      { relationDepth: 1 },
    );
    expect(result.valid).toBe(true);
  });
});

describe("validateOperation — take caps (maxTake / @@mcp(limit))", () => {
  const LIMITED_USER: McpModelDef = { ...USER_MODEL, limit: 20 };
  const LIMITED = [LIMITED_USER, POST_MODEL];

  test("take above maxTake is rejected", () => {
    const result = validateOperation(MODELS, "User", "findMany", { take: 500 }, factory, { maxTake: 100 });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.includes("take"))).toBe(true);
  });

  test("take within maxTake passes", () => {
    const result = validateOperation(MODELS, "User", "findMany", { take: 50 }, factory, { maxTake: 100 });
    expect(result.valid).toBe(true);
  });

  test("model limit caps take", () => {
    const result = validateOperation(LIMITED, "User", "findMany", { take: 21 }, factory);
    expect(result.valid).toBe(false);
  });

  test("model limit combines with maxTake via min", () => {
    const result = validateOperation(LIMITED, "User", "findMany", { take: 50 }, factory, { maxTake: 100 });
    expect(result.valid).toBe(false);
  });

  test("no cap configured leaves take unrestricted", () => {
    const result = validateOperation(MODELS, "User", "findMany", { take: 10_000 }, factory);
    expect(result.valid).toBe(true);
  });
});

describe("validateOperation — orderBy validation", () => {
  test("findMany accepts valid orderBy object", () => {
    const result = validateOperation(MODELS, "User", "findMany", { orderBy: { name: "asc" } }, factory);
    expect(result.valid).toBe(true);
  });

  test("findMany accepts orderBy array", () => {
    const result = validateOperation(MODELS, "User", "findMany", { orderBy: [{ name: "asc" }, { email: "desc" }] }, factory);
    expect(result.valid).toBe(true);
  });

  test("findMany rejects invalid orderBy direction", () => {
    const result = validateOperation(MODELS, "User", "findMany", { orderBy: { name: "sideways" } }, factory);
    expect(result.valid).toBe(false);
  });
});

describe("validateOperation — cursor validation", () => {
  test("findMany accepts cursor with @id field", () => {
    const result = validateOperation(MODELS, "User", "findMany", { cursor: { id: "1" } }, factory);
    expect(result.valid).toBe(true);
  });

  test("findMany rejects cursor field with wrong type", () => {
    const result = validateOperation(MODELS, "User", "findMany", { cursor: { id: 123 } }, factory);
    expect(result.valid).toBe(false);
  });

  test("findMany without cursor is valid", () => {
    const result = validateOperation(MODELS, "User", "findMany", {}, factory);
    expect(result.valid).toBe(true);
  });
});

describe("validateOperation — analytical operations", () => {
  test("exists passes without args", () => {
    const result = validateOperation(MODELS, "User", "exists", {}, factory);
    expect(result.valid).toBe(true);
  });

  test("aggregate passes with _count and where", () => {
    const result = validateOperation(MODELS, "User", "aggregate", { where: { name: "Alice" }, _count: true }, factory);
    expect(result.valid).toBe(true);
  });

  test("groupBy requires by", () => {
    const result = validateOperation(MODELS, "User", "groupBy", { _count: { _all: true } }, factory);
    expect(result.valid).toBe(false);
  });

  test("groupBy passes with by and aggregations", () => {
    const result = validateOperation(MODELS, "User", "groupBy", { by: ["name"], _count: { _all: true } }, factory);
    expect(result.valid).toBe(true);
  });

  test("groupBy validates where field types", () => {
    const result = validateOperation(MODELS, "User", "groupBy", { by: ["name"], where: { id: 123 } }, factory);
    expect(result.valid).toBe(false);
  });
});

describe("validateOperation — schema construction failures surface as errors", () => {
  test("factory method throwing is reported, not swallowed", () => {
    const throwing = new Proxy({}, {
      get: () => () => { throw new Error("boom"); },
    }) as unknown as QuerySchemaFactory;
    const result = validateOperation(MODELS, "User", "create", { data: { email: "a@b.com" } }, throwing);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors[0]).toContain("Cannot validate");
  });
});
