import { describe, test, expect } from "bun:test";
import { createQuerySchemaFactory } from "@zenstackhq/orm";
import {
  dedupeJsonSchemaDefs,
  sliceDocument,
  stabilizeAnonymousDefs,
} from "../tools/json-schema.js";
import { registerSchemaTool } from "../tools/schema-tool.js";
import type { QuerySchemaFactory } from "../tools/validate.js";
import type { McpModelDef, McpProcedureDef } from "../types.js";
import { testSchema } from "./fixtures/test-schema.js";

const mockModels: McpModelDef[] = [
  {
    name: "User",
    dbName: "user",
    operations: ["findMany"],
    fields: [
      { name: "id", type: "String", isId: true, isUnique: true, isRequired: true, isList: false, isRelation: false },
    ],
  },
];

const mockProcedures: McpProcedureDef[] = [
  {
    name: "checkout",
    params: [{ name: "cartId", type: "String", isList: false, isRequired: true }],
    returnType: "Order",
    returnArray: false,
    mutation: true,
  },
];

type ToolInput = { model?: string; operation?: string; component?: string; depth?: number };
type ToolOutput = { content: Array<{ type: string; text: string }>; isError?: boolean };
type ToolHandler = (input: ToolInput) => Promise<ToolOutput>;

function buildMockServer() {
  let handler: ToolHandler | undefined;
  return {
    registerTool(_name: string, _config: unknown, h: ToolHandler) {
      handler = h as ToolHandler;
    },
    call(input: ToolInput): Promise<ToolOutput> {
      if (!handler) throw new Error("tool not registered");
      return handler(input);
    },
  };
}

const textOf = (result: ToolOutput) => result.content[0]!.text;

describe("schema tool — DSL output", () => {
  test("renders models as ZModel text and includes procedures", async () => {
    const server = buildMockServer();
    registerSchemaTool(server as never, mockModels, mockProcedures);
    const text = textOf(await server.call({}));
    expect(text).toContain("model User {");
    expect(text).toContain("id String @id");
    expect(text).toContain("mutation procedure checkout(cartId: String): Order");
    // operation reference is appended for the execute tool
    expect(text).toContain("Operation arguments");
  });

  test("omits the procedures section when none are passed", async () => {
    const server = buildMockServer();
    registerSchemaTool(server as never, mockModels);
    const text = textOf(await server.call({}));
    expect(text).toContain("model User {");
    expect(text).not.toContain("procedure");
  });

  test("filtering by model name still renders procedures", async () => {
    const server = buildMockServer();
    registerSchemaTool(server as never, mockModels, mockProcedures);
    const text = textOf(await server.call({ model: "User" }));
    expect(text).toContain("model User {");
    expect(text).toContain("procedure checkout");
  });

  test("unknown model returns a JSON error", async () => {
    const server = buildMockServer();
    registerSchemaTool(server as never, mockModels, mockProcedures);
    const result = await server.call({ model: "Ghost" });
    expect(result.isError).toBe(true);
    const body = JSON.parse(textOf(result)) as { error?: string };
    expect(body.error).toContain("Ghost");
  });
});

describe("schema tool — operation JSON Schema", () => {
  const factory = createQuerySchemaFactory(
    testSchema,
  ) as unknown as QuerySchemaFactory;

  const factoryModels: McpModelDef[] = [
    {
      name: "User",
      dbName: "user",
      operations: ["findMany", "update"],
      fields: [
        { name: "id", type: "String", isId: true, isUnique: true, isRequired: true, isList: false, isRelation: false },
      ],
    },
  ];

  type ArgsSchemaResult = {
    model: string;
    operation: string;
    relationDepth: number | string;
    argsSchema: { $defs?: Record<string, unknown> } & Record<string, unknown>;
    pendingDefinitions?: string[];
    hint?: string;
  };

  type ComponentResult = {
    component: string;
    schema: { $ref?: string; $defs?: Record<string, unknown> } & Record<string, unknown>;
    pendingDefinitions?: string[];
  };

  function buildServer(relationDepth?: number) {
    const server = buildMockServer();
    registerSchemaTool(server as never, factoryModels, [], factory, relationDepth);
    return server;
  }

  test("default response is a progressive document: $refs to named $defs, unlimited recursion", async () => {
    const server = buildServer();
    const body = JSON.parse(
      textOf(await server.call({ model: "User", operation: "update" })),
    ) as ArgsSchemaResult;
    expect(body.relationDepth).toBe("unlimited");
    expect(body.argsSchema.$defs).toBeDefined();
    expect(JSON.stringify(body.argsSchema)).toContain('"$ref":"#/$defs/');
    // Every definition referenced anywhere is either included or pending.
    const included = new Set(Object.keys(body.argsSchema.$defs!));
    for (const name of body.pendingDefinitions ?? []) {
      expect(included.has(name)).toBe(false);
    }
  });

  test("a finite server relationDepth bounds the documented depth", async () => {
    const server = buildServer(2);
    const body = JSON.parse(
      textOf(await server.call({ model: "User", operation: "update" })),
    ) as ArgsSchemaResult;
    expect(body.relationDepth).toBe(2);
  });

  test("depth arg returns a self-contained document, capped by the validation depth", async () => {
    const server = buildServer(2);
    const bounded = JSON.parse(
      textOf(await server.call({ model: "User", operation: "update", depth: 1 })),
    ) as ArgsSchemaResult;
    expect(bounded.relationDepth).toBe(1);
    expect(bounded.pendingDefinitions).toBeUndefined();
    const capped = JSON.parse(
      textOf(await server.call({ model: "User", operation: "update", depth: 10 })),
    ) as ArgsSchemaResult;
    expect(capped.relationDepth).toBe(2);
  });

  test("bounded docs stay well-formed despite relation cycles (duplicate registry ids)", async () => {
    // User → posts → author re-enters User's schemas with less remaining
    // depth: the factory registers distinct instances under the same id,
    // which plain z.toJSONSchema rejects. The disambiguated registry must
    // absorb this.
    const server = buildServer(2);
    const result = await server.call({ model: "User", operation: "update", depth: 2 });
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(textOf(result)) as ArgsSchemaResult;
    expect(body.argsSchema.$defs).toBeDefined();
    // Sanity bound: with $refs + dedupe, even depth 2 on the two-model
    // fixture must stay far below the multi-MB inlined output.
    expect(textOf(result).length).toBeLessThan(200_000);
  });

  test("component fetches one named definition with its direct dependencies", async () => {
    const server = buildServer();
    const body = JSON.parse(
      textOf(await server.call({ component: "UserWhereInput" })),
    ) as ComponentResult;
    expect(body.component).toBe("UserWhereInput");
    expect(body.schema.$ref).toBe("#/$defs/UserWhereInput");
    expect(body.schema.$defs?.UserWhereInput).toBeDefined();
  });

  test("component works on a cold catalog by sweeping the exposed operations", async () => {
    // A fresh factory has an empty catalog: the lookup must build documents
    // for the exposed models/operations until the name is found.
    const coldFactory = createQuerySchemaFactory(
      testSchema,
    ) as unknown as QuerySchemaFactory;
    const server = buildMockServer();
    registerSchemaTool(server as never, factoryModels, [], coldFactory);
    const body = JSON.parse(
      textOf(await server.call({ component: "PostWhereInput" })),
    ) as ComponentResult;
    expect(body.schema.$defs?.PostWhereInput).toBeDefined();
  });

  test("unknown component returns an error listing known definitions", async () => {
    const server = buildServer();
    const result = await server.call({ component: "GhostWhereInput" });
    expect(result.isError).toBe(true);
    const body = JSON.parse(textOf(result)) as { error: string; knownDefinitions?: string[] };
    expect(body.error).toContain("GhostWhereInput");
    expect(body.knownDefinitions).toContain("UserWhereInput");
  });
});

describe("sliceDocument", () => {
  test("always includes directly-referenced defs, budgets deeper hops, lists the rest", () => {
    const big = { type: "object", properties: { pad: { enum: ["x".repeat(2000)] } } };
    const doc = {
      type: "object",
      properties: { where: { $ref: "#/$defs/Where" } },
      $defs: {
        Where: { properties: { a: { $ref: "#/$defs/Big" }, b: { $ref: "#/$defs/Small" } } },
        Big: big,
        Small: { type: "string" },
        Orphan: { type: "number" },
      },
    };
    const { schema, pending } = sliceDocument(doc as never, 200);
    // First hop (Where) forced in despite the budget; Small fits, Big does not.
    expect(Object.keys(schema.$defs!).sort()).toEqual(["Small", "Where"]);
    expect(pending).toEqual(["Big"]);
    // Unreferenced defs are neither included nor pending.
    expect(JSON.stringify(schema)).not.toContain("Orphan");
  });

  test("returns the bare root when nothing is referenced", () => {
    const doc = { type: "object", $defs: { Unused: { type: "string" } } };
    const { schema, pending } = sliceDocument(doc as never);
    expect(schema.$defs).toBeUndefined();
    expect(pending).toEqual([]);
  });
});

describe("stabilizeAnonymousDefs", () => {
  test("renames __schemaN defs to scoped names and rewrites refs", () => {
    const doc = {
      properties: { meta: { $ref: "#/$defs/__schema0" } },
      $defs: {
        __schema0: { anyOf: [{ type: "string" }, { items: { $ref: "#/$defs/__schema0" }, type: "array" }] },
        UserWhereInput: { type: "object" },
      },
    };
    stabilizeAnonymousDefs(doc as never, "UserUpdate");
    expect(Object.keys(doc.$defs).sort()).toEqual(["Anon_UserUpdate1", "UserWhereInput"]);
    expect((doc.properties.meta as { $ref: string }).$ref).toBe("#/$defs/Anon_UserUpdate1");
    // Self-reference rewritten too.
    expect(JSON.stringify(doc.$defs["Anon_UserUpdate1" as keyof typeof doc.$defs])).toContain(
      "#/$defs/Anon_UserUpdate1",
    );
  });

  test("numbers defs by zod traversal order, not lexicographic order", () => {
    const doc = {
      $defs: {
        __schema10: { type: "boolean" },
        __schema2: { type: "number" },
      },
    };
    stabilizeAnonymousDefs(doc as never, "S");
    expect(doc.$defs).toEqual({
      Anon_S1: { type: "number" },
      Anon_S2: { type: "boolean" },
    } as never);
  });
});

describe("dedupeJsonSchemaDefs", () => {
  test("merges byte-identical defs onto the shortest name and rewrites refs", () => {
    const doc = {
      properties: { a: { $ref: "#/$defs/Filter2" } },
      $defs: {
        Filter: { type: "string" },
        Filter2: { type: "string" },
        Other: { $ref: "#/$defs/Filter2" },
      },
    };
    dedupeJsonSchemaDefs(doc as never);
    expect(Object.keys(doc.$defs)).toEqual(["Filter", "Other"]);
    expect(doc.properties.a.$ref).toBe("#/$defs/Filter");
    expect((doc.$defs.Other as { $ref: string }).$ref).toBe("#/$defs/Filter");
  });

  test("runs to a fixpoint: merging children makes parents identical in turn", () => {
    const doc = {
      $defs: {
        A: { items: { $ref: "#/$defs/Leaf" } },
        A2: { items: { $ref: "#/$defs/Leaf2" } },
        Leaf: { type: "number" },
        Leaf2: { type: "number" },
      },
    };
    dedupeJsonSchemaDefs(doc as never);
    expect(Object.keys(doc.$defs).sort()).toEqual(["A", "Leaf"]);
  });

  test("is a no-op without $defs", () => {
    const doc = { type: "object" };
    expect(() => dedupeJsonSchemaDefs(doc as never)).not.toThrow();
  });
});
