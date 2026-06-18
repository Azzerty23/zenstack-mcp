import { describe, test, expect } from "bun:test";
import { registerSchemaTool } from "../tools/schema-tool.js";
import type { McpModelDef, McpProcedureDef } from "../types.js";

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

type ToolInput = { model?: string };
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
