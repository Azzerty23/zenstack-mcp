import { describe, test, expect } from "bun:test";
import { registerProcedureTool } from "../tools/procedure-tool.js";
import { requestContext } from "../context.js";
import type { McpProcedureDef } from "../types.js";

const mockProcedures: McpProcedureDef[] = [
  {
    name: "checkout",
    params: [
      { name: "cartId", type: "String", isList: false, isRequired: true },
      { name: "coupon", type: "String", isList: false, isRequired: false },
    ],
    returnType: "Order",
    returnArray: false,
    mutation: true,
  },
];

type ToolInput = { name: string; args?: Record<string, unknown> };
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

function parseText(result: ToolOutput) {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe("procedure tool — input validation", () => {
  test("unknown procedure returns isError", async () => {
    const server = buildMockServer();
    registerProcedureTool(server as never, mockProcedures, async () => ({} as never));
    const result = await server.call({ name: "refund", args: {} });
    expect(result.isError).toBe(true);
    expect(parseText(result).success).toBe(false);
  });

  test("missing required parameter returns isError", async () => {
    const server = buildMockServer();
    registerProcedureTool(server as never, mockProcedures, async () => ({} as never));
    const result = await server.call({ name: "checkout", args: { coupon: "SAVE10" } });
    expect(result.isError).toBe(true);
    const body = parseText(result);
    expect(body.success).toBe(false);
    expect(body.error).toContain("cartId");
  });

  test("null value for a required parameter is treated as missing", async () => {
    const server = buildMockServer();
    registerProcedureTool(server as never, mockProcedures, async () => ({} as never));
    const result = await server.call({ name: "checkout", args: { cartId: null } });
    expect(result.isError).toBe(true);
    expect(parseText(result).success).toBe(false);
  });

  test("optional parameter may be omitted", async () => {
    const server = buildMockServer();
    registerProcedureTool(
      server as never,
      mockProcedures,
      async () =>
        ({
          $procs: { checkout: async () => ({ id: "order-1" }) },
        }) as never,
    );
    const result = await server.call({ name: "checkout", args: { cartId: "cart-1" } });
    expect(result.isError).toBeUndefined();
    expect(parseText(result).success).toBe(true);
  });
});

describe("procedure tool — dispatch", () => {
  test("valid call dispatches to $procs and returns result", async () => {
    const order = { id: "order-1", total: 42 };
    let capturedArg: unknown;
    const server = buildMockServer();
    registerProcedureTool(
      server as never,
      mockProcedures,
      async () =>
        ({
          $procs: {
            checkout: async (arg: unknown) => {
              capturedArg = arg;
              return order;
            },
          },
        }) as never,
    );

    const result = await server.call({ name: "checkout", args: { cartId: "cart-1", coupon: "SAVE10" } });
    expect(result.isError).toBeUndefined();
    const body = parseText(result);
    expect(body.success).toBe(true);
    expect(body.result).toEqual(order);
    // Procedures are invoked with args wrapped under an `args` key.
    expect(capturedArg).toEqual({ args: { cartId: "cart-1", coupon: "SAVE10" } });
  });

  test("client error is caught and returned as isError", async () => {
    const server = buildMockServer();
    registerProcedureTool(
      server as never,
      mockProcedures,
      async () =>
        ({
          $procs: {
            checkout: async () => { throw new Error("payment declined"); },
          },
        }) as never,
    );

    const result = await server.call({ name: "checkout", args: { cartId: "cart-1" } });
    expect(result.isError).toBe(true);
    const body = parseText(result);
    expect(body.success).toBe(false);
    expect(body.error).toContain("payment declined");
  });

  test("client missing the procedure returns isError", async () => {
    const server = buildMockServer();
    registerProcedureTool(
      server as never,
      mockProcedures,
      async () => ({ $procs: {} }) as never, // no checkout
    );

    const result = await server.call({ name: "checkout", args: { cartId: "cart-1" } });
    expect(result.isError).toBe(true);
    expect(parseText(result).success).toBe(false);
  });

  test("client without a $procs surface returns isError", async () => {
    const server = buildMockServer();
    registerProcedureTool(
      server as never,
      mockProcedures,
      async () => ({}) as never,
    );

    const result = await server.call({ name: "checkout", args: { cartId: "cart-1" } });
    expect(result.isError).toBe(true);
    expect(parseText(result).success).toBe(false);
  });
});

describe("procedure tool — request context", () => {
  test("getClient receives the user from requestContext", async () => {
    const expectedUser = { id: "ctx-user", email: "bob@example.com" };
    let capturedUser: unknown;
    const server = buildMockServer();
    registerProcedureTool(
      server as never,
      mockProcedures,
      async (user) => {
        capturedUser = user;
        return { $procs: { checkout: async () => ({}) } } as never;
      },
    );

    await new Promise<void>((resolve) => {
      requestContext.run({ user: expectedUser }, async () => {
        await server.call({ name: "checkout", args: { cartId: "cart-1" } });
        resolve();
      });
    });

    expect(capturedUser).toEqual(expectedUser);
  });
});
