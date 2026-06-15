import { describe, test, expect } from "bun:test";
import { registerExecuteTool } from "../tools/execute-tool.js";
import { requestContext } from "../context.js";
import type { McpModelDef } from "../types.js";
import type { ZodFactory } from "../tools/validate.js";

const mockFields = [
  { name: "id", type: "String", isId: true, isUnique: true, isRequired: true, isList: false, isRelation: false },
  { name: "email", type: "String", isId: false, isUnique: true, isRequired: true, isList: false, isRelation: false },
];

const mockModels: McpModelDef[] = [
  {
    name: "User",
    dbName: "user",
    operations: ["findMany", "findUnique", "create", "delete"],
    fields: mockFields,
  },
];

// ZodFactory that accepts any data — keeps tests focused on dispatch logic.
const passAllFactory: ZodFactory = {
  makeModelSchema: () => ({ safeParse: () => ({ success: true }) }),
};

type ToolInput = { model: string; operation: string; args: Record<string, unknown> };
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

describe("execute tool — input validation", () => {
  test("unknown model returns isError with validation message", async () => {
    const server = buildMockServer();
    registerExecuteTool(
      server as never,
      mockModels,
      async () => ({} as never),
      passAllFactory,
    );
    const result = await server.call({ model: "Post", operation: "findMany", args: {} });
    expect(result.isError).toBe(true);
    expect(parseText(result).success).toBe(false);
  });

  test("operation not allowed on model returns isError", async () => {
    const server = buildMockServer();
    registerExecuteTool(
      server as never,
      mockModels,
      async () => ({} as never),
      passAllFactory,
    );
    const result = await server.call({ model: "User", operation: "updateMany", args: {} });
    expect(result.isError).toBe(true);
    expect(parseText(result).success).toBe(false);
  });
});

describe("execute tool — dispatch", () => {
  test("valid operation dispatches to the client and returns result", async () => {
    const mockUsers = [{ id: "1", email: "alice@example.com" }];
    const server = buildMockServer();
    registerExecuteTool(
      server as never,
      mockModels,
      async () =>
        ({
          user: { findMany: async (_args: unknown) => mockUsers },
        }) as never,
      passAllFactory,
    );

    const result = await server.call({ model: "User", operation: "findMany", args: {} });
    expect(result.isError).toBeUndefined();
    const body = parseText(result);
    expect(body.success).toBe(true);
    expect(body.result).toEqual(mockUsers);
  });

  test("client error is caught and returned as isError", async () => {
    const server = buildMockServer();
    registerExecuteTool(
      server as never,
      mockModels,
      async () =>
        ({
          user: {
            findMany: async () => { throw new Error("DB connection refused"); },
          },
        }) as never,
      passAllFactory,
    );

    const result = await server.call({ model: "User", operation: "findMany", args: {} });
    expect(result.isError).toBe(true);
    const body = parseText(result);
    expect(body.success).toBe(false);
    expect(body.error).toContain("DB connection refused");
  });

  test("missing model key on client returns error", async () => {
    const server = buildMockServer();
    registerExecuteTool(
      server as never,
      mockModels,
      async () => ({}) as never, // client has no 'user' key
      passAllFactory,
    );

    const result = await server.call({ model: "User", operation: "findMany", args: {} });
    expect(result.isError).toBe(true);
    expect(parseText(result).success).toBe(false);
  });

  test("missing operation on model client returns error", async () => {
    const server = buildMockServer();
    registerExecuteTool(
      server as never,
      mockModels,
      async () =>
        ({
          user: {}, // no findMany
        }) as never,
      passAllFactory,
    );

    const result = await server.call({ model: "User", operation: "findMany", args: {} });
    expect(result.isError).toBe(true);
    expect(parseText(result).success).toBe(false);
  });
});

describe("execute tool — mutation publishing", () => {
  function recordingPublisher() {
    const published: Array<{ channel: string; event: Record<string, unknown> }> =
      [];
    return {
      published,
      publish: async (channel: string, event: Record<string, unknown>) => {
        published.push({ channel, event });
      },
      subscribe: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined, done: true as const }) }) }),
    };
  }

  test("create publishes a create mutation with data and ids on the lowercased channel", async () => {
    const created = { id: "7", email: "neo@example.com" };
    const pub = recordingPublisher();
    const server = buildMockServer();
    registerExecuteTool(
      server as never,
      mockModels,
      async () => ({ user: { create: async () => created } }) as never,
      passAllFactory,
      undefined,
      pub as never,
    );

    await server.call({
      model: "User",
      operation: "create",
      args: { data: { email: "neo@example.com" } },
    });

    expect(pub.published).toHaveLength(1);
    expect(pub.published[0]!.channel).toBe("user");
    expect(pub.published[0]!.event).toMatchObject({
      operation: "create",
      modelName: "User",
      data: created,
      ids: ["7"],
    });
  });

  test("delete derives ids from the where clause", async () => {
    const pub = recordingPublisher();
    const server = buildMockServer();
    registerExecuteTool(
      server as never,
      mockModels,
      async () => ({ user: { delete: async () => ({ id: "3" }) } }) as never,
      passAllFactory,
      undefined,
      pub as never,
    );

    await server.call({
      model: "User",
      operation: "delete",
      args: { where: { id: "3" } },
    });

    expect(pub.published[0]!.event).toMatchObject({
      operation: "delete",
      ids: ["3"],
    });
  });

  test("read operations do not publish", async () => {
    const pub = recordingPublisher();
    const server = buildMockServer();
    registerExecuteTool(
      server as never,
      mockModels,
      async () => ({ user: { findMany: async () => [] } }) as never,
      passAllFactory,
      undefined,
      pub as never,
    );

    await server.call({ model: "User", operation: "findMany", args: {} });
    expect(pub.published).toHaveLength(0);
  });

  test("a custom channelFormatter is honored", async () => {
    const pub = recordingPublisher();
    const server = buildMockServer();
    registerExecuteTool(
      server as never,
      mockModels,
      async () => ({ user: { create: async () => ({ id: "1" }) } }) as never,
      passAllFactory,
      undefined,
      pub as never,
      (model) => `model:${model}`,
    );

    await server.call({ model: "User", operation: "create", args: { data: {} } });
    expect(pub.published[0]!.channel).toBe("model:User");
  });

  test("a failing publisher does not fail the write", async () => {
    const server = buildMockServer();
    registerExecuteTool(
      server as never,
      mockModels,
      async () => ({ user: { create: async () => ({ id: "1" }) } }) as never,
      passAllFactory,
      undefined,
      {
        publish: async () => {
          throw new Error("publisher down");
        },
        subscribe: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined, done: true as const }) }) }),
      } as never,
    );

    const result = await server.call({
      model: "User",
      operation: "create",
      args: { data: {} },
    });
    expect(result.isError).toBeUndefined();
    expect(parseText(result).success).toBe(true);
  });
});

describe("execute tool — request context", () => {
  test("getClient receives the user from requestContext", async () => {
    const expectedUser = { id: "ctx-user", email: "bob@example.com" };
    let capturedUser: unknown;
    const server = buildMockServer();
    registerExecuteTool(
      server as never,
      mockModels,
      async (user) => {
        capturedUser = user;
        return {
          user: { findMany: async () => [] },
        } as never;
      },
      passAllFactory,
    );

    await new Promise<void>((resolve) => {
      requestContext.run({ user: expectedUser }, async () => {
        await server.call({ model: "User", operation: "findMany", args: {} });
        resolve();
      });
    });

    expect(capturedUser).toEqual(expectedUser);
  });

  test("getClient receives undefined when called outside a request context", async () => {
    let capturedUser: unknown = "sentinel";
    const server = buildMockServer();
    registerExecuteTool(
      server as never,
      mockModels,
      async (user) => {
        capturedUser = user;
        return {
          user: { findMany: async () => [] },
        } as never;
      },
      passAllFactory,
    );

    await server.call({ model: "User", operation: "findMany", args: {} });
    expect(capturedUser).toBeUndefined();
  });
});
