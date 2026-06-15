import { describe, test, expect } from "bun:test";
import { registerMeTool } from "../tools/me-tool.js";
import { requestContext } from "../context.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

function buildMockServer() {
  let handler: ToolHandler | undefined;
  return {
    registerTool(_name: string, _config: unknown, h: ToolHandler) {
      handler = h;
    },
    call() {
      if (!handler) throw new Error("tool not registered");
      return handler({});
    },
  };
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  const [first] = result.content;
  return JSON.parse(first!.text) as { user: unknown };
}

describe("me tool — unauthenticated", () => {
  test("returns null when called outside a request context", async () => {
    const server = buildMockServer();
    registerMeTool(server as unknown as Parameters<typeof registerMeTool>[0]);
    const result = await server.call();
    expect(parseResult(result).user).toBeNull();
  });
});

describe("me tool — authenticated", () => {
  test("returns the user stored in the request context", async () => {
    const server = buildMockServer();
    registerMeTool(server as unknown as Parameters<typeof registerMeTool>[0]);
    const user = { id: "user-1", email: "alice@example.com" };

    let result: Awaited<ReturnType<typeof server.call>>;
    await new Promise<void>((resolve) => {
      requestContext.run({ user }, async () => {
        result = await server.call();
        resolve();
      });
    });

    expect(parseResult(result!).user).toEqual(user);
  });

  test("reflects the correct user in nested contexts", async () => {
    const server = buildMockServer();
    registerMeTool(server as unknown as Parameters<typeof registerMeTool>[0]);
    const outer = { id: "outer" };
    const inner = { id: "inner" };
    const results: unknown[] = [];

    await new Promise<void>((resolve) => {
      requestContext.run({ user: outer }, async () => {
        results.push(parseResult(await server.call()).user);
        await new Promise<void>((innerResolve) => {
          requestContext.run({ user: inner }, async () => {
            results.push(parseResult(await server.call()).user);
            innerResolve();
          });
        });
        results.push(parseResult(await server.call()).user);
        resolve();
      });
    });

    expect(results).toEqual([outer, inner, outer]);
  });

  test("returns null after the context run exits", async () => {
    const server = buildMockServer();
    registerMeTool(server as unknown as Parameters<typeof registerMeTool>[0]);

    await new Promise<void>((resolve) => {
      requestContext.run({ user: { id: "x" } }, () => resolve());
    });

    const result = await server.call();
    expect(parseResult(result).user).toBeNull();
  });
});
