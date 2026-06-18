import { describe, test, expect } from "bun:test";
import { renderSchema } from "../tools/schema-renderer.js";
import { ALL_OPERATIONS } from "../types.js";
import type { McpModelDef, McpProcedureDef } from "../types.js";

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
