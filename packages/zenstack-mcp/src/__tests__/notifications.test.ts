import { describe, expect, test } from "bun:test";
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  bridgeModelMutations,
  modelResourceUri,
  registerModelResources,
} from "../events/notifications.js";
import { createInMemoryPublisher } from "../events/publisher.js";
import { requestContext } from "../context.js";
import type { McpModelDef } from "../types.js";

const models: McpModelDef[] = [
  {
    name: "Post",
    dbName: "post",
    operations: ["findMany"],
    fields: [
      { name: "id", type: "String", isId: true, isUnique: true, isRequired: true, isList: false, isRelation: false },
    ],
  },
];

type Handler = (req: unknown, extra?: unknown) => unknown;

/** Minimal McpServer stand-in capturing the bits the helpers touch. */
function mockServer() {
  const resources: Array<{ name: string; uri: string; cb: Handler }> = [];
  const requestHandlers = new Map<unknown, Handler>();
  const capabilities: Record<string, unknown>[] = [];
  const updated: string[] = [];
  const inner = {
    registerCapabilities: (c: Record<string, unknown>) => capabilities.push(c),
    setRequestHandler: (schema: unknown, handler: Handler) =>
      requestHandlers.set(schema, handler),
    sendResourceUpdated: async (params: { uri: string }) => {
      updated.push(params.uri);
    },
    onclose: undefined as (() => void) | undefined,
  };
  return {
    server: inner,
    registerResource: (name: string, uri: string, _cfg: unknown, cb: Handler) =>
      resources.push({ name, uri, cb }),
    // test accessors
    _resources: resources,
    _handlers: requestHandlers,
    _capabilities: capabilities,
    _updated: updated,
  };
}

describe("modelResourceUri", () => {
  test("preserves PascalCase model name", () => {
    expect(modelResourceUri("Post")).toBe("zenstack://Post");
    expect(modelResourceUri("UserProfile")).toBe("zenstack://UserProfile");
  });
});

describe("registerModelResources", () => {
  test("registers a resource per model and reads via getClient", async () => {
    const server = mockServer();
    const rows = [{ id: "1" }];
    registerModelResources(
      server as never,
      models,
      async () => ({ post: { findMany: async () => rows } }) as never,
    );

    expect(server._resources).toHaveLength(1);
    expect(server._resources[0]!.uri).toBe("zenstack://Post");

    const result = (await requestContext.run({ user: {} }, () =>
      server._resources[0]!.cb(new URL("zenstack://Post")),
    )) as { contents: Array<{ uri: string; text: string }> };
    expect(result.contents[0]!.uri).toBe("zenstack://Post");
    expect(JSON.parse(result.contents[0]!.text)).toEqual(rows);
  });
});

describe("bridgeModelMutations", () => {
  test("declares the subscribe capability", () => {
    const server = mockServer();
    bridgeModelMutations(server as never, models, createInMemoryPublisher());
    expect(server._capabilities).toContainEqual({
      resources: { subscribe: true },
    });
  });

  test("emits resources/updated for a subscribed model on mutation", async () => {
    const server = mockServer();
    const publisher = createInMemoryPublisher();
    bridgeModelMutations(server as never, models, publisher);

    // Client subscribes to the Post resource.
    server._handlers.get(SubscribeRequestSchema)!({
      params: { uri: "zenstack://Post" },
    });

    await publisher.publish("post", {
      operation: "create",
      modelName: "Post",
      ids: ["1"],
      timestamp: 1,
    });
    // Let the subscribe loop deliver and call sendResourceUpdated.
    await new Promise((r) => setTimeout(r, 5));

    expect(server._updated).toEqual(["zenstack://Post"]);
  });

  test("does not emit after unsubscribe", async () => {
    const server = mockServer();
    const publisher = createInMemoryPublisher();
    bridgeModelMutations(server as never, models, publisher);

    server._handlers.get(SubscribeRequestSchema)!({
      params: { uri: "zenstack://Post" },
    });
    server._handlers.get(UnsubscribeRequestSchema)!({
      params: { uri: "zenstack://Post" },
    });

    await publisher.publish("post", {
      operation: "update",
      modelName: "Post",
      timestamp: 1,
    });
    await new Promise((r) => setTimeout(r, 5));

    expect(server._updated).toHaveLength(0);
  });

  test("ignores subscriptions to unknown resource URIs", async () => {
    const server = mockServer();
    const publisher = createInMemoryPublisher();
    bridgeModelMutations(server as never, models, publisher);

    server._handlers.get(SubscribeRequestSchema)!({
      params: { uri: "zenstack://Unknown" },
    });
    await publisher.publish("unknown", {
      operation: "create",
      modelName: "Unknown",
      timestamp: 1,
    });
    await new Promise((r) => setTimeout(r, 5));

    expect(server._updated).toHaveLength(0);
  });

  test("onclose tears down active loops and chains the previous handler", async () => {
    const server = mockServer();
    let previousCalled = false;
    server.server.onclose = () => {
      previousCalled = true;
    };
    const publisher = createInMemoryPublisher();
    bridgeModelMutations(server as never, models, publisher);

    server._handlers.get(SubscribeRequestSchema)!({
      params: { uri: "zenstack://Post" },
    });
    server.server.onclose!();

    await publisher.publish("post", {
      operation: "create",
      modelName: "Post",
      timestamp: 1,
    });
    await new Promise((r) => setTimeout(r, 5));

    expect(previousCalled).toBe(true);
    expect(server._updated).toHaveLength(0);
  });
});
