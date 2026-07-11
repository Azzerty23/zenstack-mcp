import { describe, test, expect } from "bun:test";
import { ExpressionUtils } from "@zenstackhq/schema";
import { renderSchema } from "../tools/schema-renderer.js";
import { ALL_OPERATIONS } from "../types.js";
import type { McpEnumDef, McpModelDef, McpProcedureDef, McpTypeDef } from "../types.js";

const userModel: McpModelDef = {
  name: "User",
  dbName: "user",
  operations: [...ALL_OPERATIONS],
  fields: [
    { name: "id", type: "String", isId: true, isUnique: true, isRequired: true, isList: false, isRelation: false },
    { name: "email", type: "String", isId: false, isUnique: true, isRequired: true, isList: false, isRelation: false },
    { name: "name", type: "String", isId: false, isUnique: false, isRequired: false, isList: false, isRelation: false },
    { name: "posts", type: "Post", isId: false, isUnique: false, isRequired: true, isList: true, isRelation: true },
  ],
};

describe("renderSchema — fields", () => {
  test("renders id, unique, optional and list modifiers", () => {
    const out = renderSchema([userModel], []);
    expect(out).toContain("model User {");
    expect(out).toContain("  id String @id");
    expect(out).toContain("  email String @unique");
    expect(out).toContain("  name String?"); // optional
    expect(out).toContain("  posts Post[]"); // list relation
  });

  test("id field is not also annotated @unique", () => {
    const out = renderSchema([userModel], []);
    expect(out).not.toContain("@id @unique");
  });
});

describe("renderSchema — operations", () => {
  test("full operation set is not noted per model", () => {
    const out = renderSchema([userModel], []);
    expect(out).not.toContain("// operations:");
    // but the default set is declared once in the header
    expect(out).toContain("Default operations");
  });

  test("restricted operations are noted inside the model", () => {
    const restricted: McpModelDef = { ...userModel, operations: ["findMany", "count"] };
    const out = renderSchema([restricted], []);
    expect(out).toContain("  // operations: findMany, count");
  });
});

describe("renderSchema — procedures", () => {
  test("renders query and mutation procedures with optional params", () => {
    const procs: McpProcedureDef[] = [
      { name: "getCartTotal", params: [{ name: "cartId", type: "String", isList: false, isRequired: true }], returnType: "Int", returnArray: false, mutation: false },
      { name: "checkout", params: [
        { name: "cartId", type: "String", isList: false, isRequired: true },
        { name: "coupon", type: "String", isList: false, isRequired: false },
      ], returnType: "Order", returnArray: false, mutation: true },
    ];
    const out = renderSchema([userModel], procs);
    expect(out).toContain("procedure getCartTotal(cartId: String): Int");
    expect(out).toContain("mutation procedure checkout(cartId: String, coupon: String?): Order");
  });

  test("no procedures section when the list is empty", () => {
    const out = renderSchema([userModel], []);
    expect(out).not.toContain("procedure");
  });
});

describe("renderSchema — empty", () => {
  test("notes when no models are exposed", () => {
    const out = renderSchema([], []);
    expect(out).toContain("(no models exposed)");
  });
});

describe("renderSchema — enums", () => {
  const role: McpEnumDef = { name: "Role", values: ["USER", "ADMIN"] };

  test("renders an enum block with one member per line", () => {
    const out = renderSchema([userModel], [], [role]);
    expect(out).toContain("enum Role {\n  USER\n  ADMIN\n}");
  });

  test("renders enum-level attributes", () => {
    const mapped: McpEnumDef = {
      ...role,
      attributes: [{ name: "@@map", args: [{ value: ExpressionUtils.literal("roles") }] }],
    };
    const out = renderSchema([userModel], [], [mapped]);
    expect(out).toContain('@@map("roles")');
  });

  test("no enum block when there are no enums", () => {
    const out = renderSchema([userModel], []);
    expect(out).not.toContain("enum ");
  });
});

describe("renderSchema — type declarations", () => {
  const address: McpTypeDef = {
    name: "Address",
    fields: [
      { name: "street", type: "String", isId: false, isUnique: false, isRequired: true, isList: false, isRelation: false },
      { name: "zip", type: "String", isId: false, isUnique: false, isRequired: false, isList: false, isRelation: false },
    ],
  };

  test("renders a type block with the `type` keyword and field modifiers", () => {
    const out = renderSchema([userModel], [], [], [address]);
    expect(out).toContain("type Address {");
    expect(out).toContain("  street String");
    expect(out).toContain("  zip String?");
  });
});

describe("renderSchema — attributes", () => {
  const withAttrs: McpModelDef = {
    name: "Post",
    dbName: "post",
    operations: [...ALL_OPERATIONS],
    fields: [
      {
        name: "id",
        type: "String",
        isId: true,
        isUnique: false,
        isRequired: true,
        isList: false,
        isRelation: false,
        attributes: [
          { name: "@id" },
          { name: "@default", args: [{ name: "value", value: ExpressionUtils.call("cuid") }] },
        ],
      },
      {
        name: "author",
        type: "User",
        isId: false,
        isUnique: false,
        isRequired: true,
        isList: false,
        isRelation: true,
        attributes: [
          {
            name: "@relation",
            args: [
              { name: "fields", value: ExpressionUtils.array("String", [ExpressionUtils.field("authorId")]) },
              { name: "references", value: ExpressionUtils.array("String", [ExpressionUtils.field("id")]) },
            ],
          },
        ],
      },
      {
        name: "secret",
        type: "String",
        isId: false,
        isUnique: false,
        isRequired: true,
        isList: false,
        isRelation: false,
        attributes: [
          { name: "@deny", args: [{ value: ExpressionUtils.literal("read") }] },
          { name: "@map", args: [{ value: ExpressionUtils.literal("secret_col") }] },
        ],
      },
    ],
    attributes: [
      { name: "@@map", args: [{ value: ExpressionUtils.literal("posts") }] },
      { name: "@@allow", args: [{ value: ExpressionUtils.literal("all") }] },
    ],
  };

  test("renders a single-arg attribute positionally", () => {
    const out = renderSchema([withAttrs], []);
    expect(out).toContain("id String @id @default(cuid())");
  });

  test("renders a multi-arg attribute with named args", () => {
    const out = renderSchema([withAttrs], []);
    expect(out).toContain("author User @relation(fields: [authorId], references: [id])");
  });

  test("renders model-level attributes", () => {
    const out = renderSchema([withAttrs], []);
    expect(out).toContain('  @@map("posts")');
  });

  test("strips field-level policy attributes but keeps the rest", () => {
    const out = renderSchema([withAttrs], []);
    expect(out).toContain('secret String @map("secret_col")');
    expect(out).not.toContain("@deny");
  });

  test("strips model-level policy attributes", () => {
    const out = renderSchema([withAttrs], []);
    expect(out).not.toContain("@@allow");
  });
});
