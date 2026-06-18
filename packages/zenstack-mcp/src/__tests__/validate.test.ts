import { describe, test, expect } from "bun:test";
import { validateOperation } from "../tools/validate.js";
import { ALL_OPERATIONS } from "../types.js";
import type { McpModelDef } from "../types.js";

const USER_MODEL: McpModelDef = {
  name: "User",
  dbName: "user",
  operations: ["findMany", "findUnique", "findFirst", "create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany", "count"],
  fields: [
    { name: "id",    type: "String", isId: true,  isUnique: false, isRequired: true,  isList: false, isRelation: false },
    { name: "email", type: "String", isId: false, isUnique: true,  isRequired: true,  isList: false, isRelation: false },
    { name: "name",  type: "String", isId: false, isUnique: false, isRequired: false, isList: false, isRelation: false },
  ],
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

const noopFactory = {
  makeModelSchema: () => ({ safeParse: () => ({ success: true as const }) }),
};

describe("validateOperation — model/operation guards", () => {
  test("returns error for unknown model", () => {
    const result = validateOperation(MODELS, "Comment", "findMany", {}, noopFactory);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors[0]).toContain("Unknown model");
  });

  test("returns error for operation not in model's allowlist", () => {
    const result = validateOperation(MODELS, "Post", "delete", { where: { id: "1" } }, noopFactory);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors[0]).toContain(`Operation "delete" not available`);
  });

  test("passes for valid model and allowed operation", () => {
    const result = validateOperation(MODELS, "Post", "findMany", {}, noopFactory);
    expect(result.valid).toBe(true);
  });
});

describe("validateOperation — arg structure validation", () => {
  test("findUnique requires where", () => {
    const result = validateOperation(MODELS, "User", "findUnique", {}, noopFactory);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.includes("where"))).toBe(true);
  });

  test("findUnique passes with where", () => {
    const result = validateOperation(MODELS, "User", "findUnique", { where: { id: "1" } }, noopFactory);
    expect(result.valid).toBe(true);
  });

  test("create requires data", () => {
    const result = validateOperation(MODELS, "User", "create", {}, noopFactory);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.includes("data"))).toBe(true);
  });

  test("create passes with data", () => {
    const result = validateOperation(MODELS, "User", "create", { data: { email: "a@b.com" } }, noopFactory);
    expect(result.valid).toBe(true);
  });

  test("update requires where and data", () => {
    const result = validateOperation(MODELS, "User", "update", {}, noopFactory);
    expect(result.valid).toBe(false);
  });

  test("update passes with where and data", () => {
    const result = validateOperation(MODELS, "User", "update", { where: { id: "1" }, data: { name: "Alice" } }, noopFactory);
    expect(result.valid).toBe(true);
  });

  test("delete requires where", () => {
    const result = validateOperation(MODELS, "User", "delete", {}, noopFactory);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.includes("where"))).toBe(true);
  });

  test("findMany passes without args", () => {
    const result = validateOperation(MODELS, "User", "findMany", {}, noopFactory);
    expect(result.valid).toBe(true);
  });

  test("findMany passes with pagination args", () => {
    const result = validateOperation(MODELS, "User", "findMany", { skip: 0, take: 10 }, noopFactory);
    expect(result.valid).toBe(true);
  });

  test("findMany rejects non-integer skip", () => {
    const result = validateOperation(MODELS, "User", "findMany", { skip: 1.5 }, noopFactory);
    expect(result.valid).toBe(false);
  });

  test("createMany requires data array", () => {
    const result = validateOperation(MODELS, "User", "createMany", { data: { email: "a@b.com" } }, noopFactory);
    expect(result.valid).toBe(false);
  });

  test("createMany passes with data array", () => {
    const result = validateOperation(MODELS, "User", "createMany", { data: [{ email: "a@b.com" }] }, noopFactory);
    expect(result.valid).toBe(true);
  });
});

describe("validateOperation — unique where (update / delete / upsert / findUnique)", () => {
  test("findUnique accepts @unique field (email)", () => {
    const result = validateOperation(MODELS, "User", "findUnique", { where: { email: "a@b.com" } }, noopFactory);
    expect(result.valid).toBe(true);
  });

  test("update rejects non-unique where field", () => {
    const result = validateOperation(MODELS, "User", "update", { where: { name: "Alice" }, data: { name: "Bob" } }, noopFactory);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.includes("where"))).toBe(true);
  });

  test("update accepts @unique field in where", () => {
    const result = validateOperation(MODELS, "User", "update", { where: { email: "a@b.com" }, data: { name: "Alice" } }, noopFactory);
    expect(result.valid).toBe(true);
  });

  test("delete rejects non-unique where field", () => {
    const result = validateOperation(MODELS, "User", "delete", { where: { name: "Alice" } }, noopFactory);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.includes("where"))).toBe(true);
  });

  test("delete accepts @unique field in where", () => {
    const result = validateOperation(MODELS, "User", "delete", { where: { email: "a@b.com" } }, noopFactory);
    expect(result.valid).toBe(true);
  });

  test("upsert rejects non-unique where field", () => {
    const result = validateOperation(MODELS, "User", "upsert", { where: { name: "Alice" }, create: { email: "a@b.com" }, update: { name: "Alice" } }, noopFactory);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.includes("where"))).toBe(true);
  });

  test("upsert accepts @unique field in where", () => {
    const result = validateOperation(MODELS, "User", "upsert", { where: { email: "a@b.com" }, create: { email: "a@b.com" }, update: { name: "Alice" } }, noopFactory);
    expect(result.valid).toBe(true);
  });
});

describe("validateOperation — requireWhereForBulk", () => {
  test("rejects deleteMany without where when requireWhereForBulk", () => {
    const result = validateOperation(MODELS, "User", "deleteMany", {}, noopFactory, true);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors[0]).toContain("requireWhereForBulk");
  });

  test("rejects deleteMany with empty where when requireWhereForBulk", () => {
    const result = validateOperation(MODELS, "User", "deleteMany", { where: {} }, noopFactory, true);
    expect(result.valid).toBe(false);
  });

  test("passes deleteMany with non-empty where", () => {
    const result = validateOperation(MODELS, "User", "deleteMany", { where: { id: "1" } }, noopFactory, true);
    expect(result.valid).toBe(true);
  });

  test("rejects updateMany without where when requireWhereForBulk", () => {
    const result = validateOperation(MODELS, "User", "updateMany", { data: { name: "X" } }, noopFactory, true);
    expect(result.valid).toBe(false);
  });

  test("passes deleteMany without where when requireWhereForBulk is false", () => {
    const result = validateOperation(MODELS, "User", "deleteMany", {}, noopFactory, false);
    expect(result.valid).toBe(true);
  });
});

describe("validateOperation — zodFactory data validation", () => {
  const zodFactory = {
    makeModelSchema: (_model: string, opts?: { optionality: string }) => ({
      safeParse: (v: unknown) => {
        const obj = v as Record<string, unknown>;
        if (opts?.optionality === "defaults") {
          if (!obj.email) {
            return { success: false, error: { issues: [{ message: "email is required", path: ["email"] }] } };
          }
        }
        return { success: true };
      },
    }),
  };

  test("create validates data via zodFactory", () => {
    const result = validateOperation(MODELS, "User", "create", { data: {} }, zodFactory);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.includes("email"))).toBe(true);
  });

  test("create passes when data satisfies zodFactory", () => {
    const result = validateOperation(MODELS, "User", "create", { data: { email: "a@b.com" } }, zodFactory);
    expect(result.valid).toBe(true);
  });

  test("createMany validates each item via zodFactory", () => {
    const result = validateOperation(
      MODELS,
      "User",
      "createMany",
      { data: [{ email: "a@b.com" }, {}] },
      zodFactory,
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.includes("data[1]"))).toBe(true);
  });

  test("zodFactory errors are silenced for unsupported operations", () => {
    const throwingFactory = {
      makeModelSchema: () => { throw new Error("unsupported"); },
    };
    const result = validateOperation(MODELS, "User", "create", { data: { email: "a@b.com" } }, throwingFactory);
    expect(result.valid).toBe(true);
  });
});

describe("validateOperation — skip/take edge cases", () => {
  test("rejects negative skip", () => {
    const result = validateOperation(MODELS, "User", "findMany", { skip: -1 }, noopFactory);
    expect(result.valid).toBe(false);
  });

  test("accepts negative take (Prisma tail cursor semantics)", () => {
    const result = validateOperation(MODELS, "User", "findMany", { take: -5 }, noopFactory);
    expect(result.valid).toBe(true);
  });

  test("rejects fractional skip", () => {
    const result = validateOperation(MODELS, "User", "findMany", { skip: 1.5 }, noopFactory);
    expect(result.valid).toBe(false);
  });
});

describe("validateOperation — orderBy validation", () => {
  test("findMany accepts valid orderBy object", () => {
    const result = validateOperation(MODELS, "User", "findMany", { orderBy: { name: "asc" } }, noopFactory);
    expect(result.valid).toBe(true);
  });

  test("findMany accepts orderBy array", () => {
    const result = validateOperation(MODELS, "User", "findMany", { orderBy: [{ name: "asc" }, { email: "desc" }] }, noopFactory);
    expect(result.valid).toBe(true);
  });

  test("findMany rejects invalid orderBy direction", () => {
    const result = validateOperation(MODELS, "User", "findMany", { orderBy: { name: "sideways" } }, noopFactory);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.includes("orderBy"))).toBe(true);
  });

  test("findFirst accepts valid orderBy", () => {
    const result = validateOperation(MODELS, "User", "findFirst", { orderBy: { email: "desc" } }, noopFactory);
    expect(result.valid).toBe(true);
  });

  test("findFirst rejects invalid orderBy direction", () => {
    const result = validateOperation(MODELS, "User", "findFirst", { orderBy: { email: "ASCENDING" } }, noopFactory);
    expect(result.valid).toBe(false);
  });
});

describe("validateOperation — where field type mismatch", () => {
  test("findMany rejects wrong type for String field in where", () => {
    const result = validateOperation(MODELS, "User", "findMany", { where: { id: 123 } }, noopFactory);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.includes("where"))).toBe(true);
  });

  test("findUnique rejects number for String id", () => {
    const result = validateOperation(MODELS, "User", "findUnique", { where: { id: 123 } }, noopFactory);
    expect(result.valid).toBe(false);
  });

  test("findUnique accepts correct type for String id", () => {
    const result = validateOperation(MODELS, "User", "findUnique", { where: { id: "abc" } }, noopFactory);
    expect(result.valid).toBe(true);
  });
});

describe("validateOperation — upsert where empty object", () => {
  test("rejects upsert with empty where", () => {
    const result = validateOperation(
      MODELS, "User", "upsert",
      { where: {}, create: { email: "a@b.com" }, update: { name: "Alice" } },
      noopFactory,
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.includes("where"))).toBe(true);
  });

  test("passes upsert with valid unique where", () => {
    const result = validateOperation(
      MODELS, "User", "upsert",
      { where: { id: "1" }, create: { email: "a@b.com" }, update: { name: "Alice" } },
      noopFactory,
    );
    expect(result.valid).toBe(true);
  });
});

describe("validateOperation — cursor validation", () => {
  test("findMany accepts cursor with @id field", () => {
    const result = validateOperation(MODELS, "User", "findMany", { cursor: { id: "1" } }, noopFactory);
    expect(result.valid).toBe(true);
  });

  test("findMany accepts cursor with @unique field", () => {
    const result = validateOperation(MODELS, "User", "findMany", { cursor: { email: "a@b.com" } }, noopFactory);
    expect(result.valid).toBe(true);
  });

  test("findMany rejects cursor with non-unique field", () => {
    const result = validateOperation(MODELS, "User", "findMany", { cursor: { name: "Alice" } }, noopFactory);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.includes("cursor"))).toBe(true);
  });

  test("findMany rejects empty cursor", () => {
    const result = validateOperation(MODELS, "User", "findMany", { cursor: {} }, noopFactory);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.includes("cursor"))).toBe(true);
  });

  test("findMany rejects cursor field with wrong type", () => {
    const result = validateOperation(MODELS, "User", "findMany", { cursor: { id: 123 } }, noopFactory);
    expect(result.valid).toBe(false);
  });

  test("findFirst accepts cursor with @id field", () => {
    const result = validateOperation(MODELS, "User", "findFirst", { cursor: { id: "1" } }, noopFactory);
    expect(result.valid).toBe(true);
  });

  test("findFirst rejects cursor with non-unique field", () => {
    const result = validateOperation(MODELS, "User", "findFirst", { cursor: { name: "Alice" } }, noopFactory);
    expect(result.valid).toBe(false);
  });

  test("findMany without cursor is valid", () => {
    const result = validateOperation(MODELS, "User", "findMany", {}, noopFactory);
    expect(result.valid).toBe(true);
  });
});

describe("validateOperation — extended CRUD operations", () => {
  // Model exposing every operation in the ORM (createManyAndReturn, aggregate, groupBy, …).
  const FULL_MODEL: McpModelDef = { ...USER_MODEL, operations: [...ALL_OPERATIONS] };
  const FULL = [FULL_MODEL];

  test("findUniqueOrThrow requires where", () => {
    const result = validateOperation(FULL, "User", "findUniqueOrThrow", {}, noopFactory);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.includes("where"))).toBe(true);
  });

  test("findUniqueOrThrow rejects non-unique where field", () => {
    const result = validateOperation(FULL, "User", "findUniqueOrThrow", { where: { name: "Alice" } }, noopFactory);
    expect(result.valid).toBe(false);
  });

  test("findUniqueOrThrow accepts @unique where", () => {
    const result = validateOperation(FULL, "User", "findUniqueOrThrow", { where: { email: "a@b.com" } }, noopFactory);
    expect(result.valid).toBe(true);
  });

  test("findFirstOrThrow passes without args", () => {
    const result = validateOperation(FULL, "User", "findFirstOrThrow", {}, noopFactory);
    expect(result.valid).toBe(true);
  });

  test("findFirstOrThrow validates orderBy direction", () => {
    const result = validateOperation(FULL, "User", "findFirstOrThrow", { orderBy: { name: "sideways" } }, noopFactory);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.includes("orderBy"))).toBe(true);
  });

  test("findFirstOrThrow validates cursor uniqueness", () => {
    const result = validateOperation(FULL, "User", "findFirstOrThrow", { cursor: { name: "Alice" } }, noopFactory);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.includes("cursor"))).toBe(true);
  });

  test("createManyAndReturn requires a data array", () => {
    const result = validateOperation(FULL, "User", "createManyAndReturn", { data: { email: "a@b.com" } }, noopFactory);
    expect(result.valid).toBe(false);
  });

  test("createManyAndReturn validates each item via zodFactory", () => {
    const zodFactory = {
      makeModelSchema: () => ({
        safeParse: (v: unknown) =>
          (v as Record<string, unknown>).email
            ? { success: true as const }
            : { success: false as const, error: { issues: [{ message: "email is required", path: ["email"] }] } },
      }),
    };
    const result = validateOperation(FULL, "User", "createManyAndReturn", { data: [{ email: "a@b.com" }, {}] }, zodFactory);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.includes("data[1]"))).toBe(true);
  });

  test("updateManyAndReturn requires data", () => {
    const result = validateOperation(FULL, "User", "updateManyAndReturn", {}, noopFactory);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.includes("data"))).toBe(true);
  });

  test("updateManyAndReturn passes with where and data", () => {
    const result = validateOperation(FULL, "User", "updateManyAndReturn", { where: { name: "Alice" }, data: { name: "Bob" } }, noopFactory);
    expect(result.valid).toBe(true);
  });

  test("updateManyAndReturn is subject to requireWhereForBulk", () => {
    const result = validateOperation(FULL, "User", "updateManyAndReturn", { data: { name: "X" } }, noopFactory, true);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors[0]).toContain("requireWhereForBulk");
  });

  test("exists passes without args", () => {
    const result = validateOperation(FULL, "User", "exists", {}, noopFactory);
    expect(result.valid).toBe(true);
  });

  test("exists validates where field types", () => {
    const result = validateOperation(FULL, "User", "exists", { where: { id: 123 } }, noopFactory);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.includes("where"))).toBe(true);
  });

  test("aggregate passes with _count and where", () => {
    const result = validateOperation(FULL, "User", "aggregate", { where: { name: "Alice" }, _count: true }, noopFactory);
    expect(result.valid).toBe(true);
  });

  test("aggregate validates orderBy direction", () => {
    const result = validateOperation(FULL, "User", "aggregate", { orderBy: { name: "sideways" } }, noopFactory);
    expect(result.valid).toBe(false);
  });

  test("groupBy requires by", () => {
    const result = validateOperation(FULL, "User", "groupBy", { _count: { _all: true } }, noopFactory);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.includes("by"))).toBe(true);
  });

  test("groupBy passes with by and aggregations", () => {
    const result = validateOperation(FULL, "User", "groupBy", { by: ["name"], _count: { _all: true } }, noopFactory);
    expect(result.valid).toBe(true);
  });

  test("groupBy validates where field types", () => {
    const result = validateOperation(FULL, "User", "groupBy", { by: ["name"], where: { id: 123 } }, noopFactory);
    expect(result.valid).toBe(false);
  });
});
