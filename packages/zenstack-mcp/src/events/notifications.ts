import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { SchemaDef } from "@zenstackhq/schema";
import type { AuthType } from "@zenstackhq/orm";
import type {
  McpModelDef,
  McpServerConfig,
  MutationPublisher,
  ZenStackClientShape,
} from "../types.js";
import { getRequestUser } from "../context.js";
import { defaultChannel } from "./publisher.js";

/**
 * Stable resource URI for a model's collection. A plain string (not built via
 * `URL`, whose host segment lowercases) so the PascalCase model name is
 * preserved end to end: resources/list → resources/subscribe → resources/updated.
 */
export function modelResourceUri(modelName: string): string {
  return `zenstack://${modelName}`;
}

/**
 * Registers each exposed model as a readable MCP resource (`zenstack://<Model>`),
 * so clients can discover collections via `resources/list`, read them with
 * `resources/read`, and target them with `resources/subscribe`.
 *
 * The read callback runs the same auth-enforced `findMany` the `execute` tool
 * would, resolving the user from the active request context. Must be called
 * **before** `server.connect(...)`.
 */
export function registerModelResources<Schema extends SchemaDef>(
  server: McpServer,
  models: McpModelDef[],
  getClient: McpServerConfig<Schema>["getClient"],
): void {
  for (const model of models) {
    const uri = modelResourceUri(model.name);
    server.registerResource(
      model.name,
      uri,
      {
        description: `All ${model.name} records (access-policy enforced)`,
        mimeType: "application/json",
      },
      async () => {
        const user = getRequestUser() as AuthType<Schema>;
        const client = (await getClient(user)) as ZenStackClientShape;
        const findMany = client[model.dbName]?.findMany;
        const data = findMany ? await findMany({}) : [];
        return {
          contents: [
            { uri, mimeType: "application/json", text: JSON.stringify(data) },
          ],
        };
      },
    );
  }
}

export interface BridgeMutationsOptions {
  /** Maps a model name to its publish channel (default: `model.toLowerCase()`). */
  channelFormatter?: (modelName: string) => string;
}

/**
 * Bridges {@link MutationPublisher} events to MCP `notifications/resources/updated`.
 *
 * Declares the `resources.subscribe` capability and installs `resources/subscribe`
 * / `resources/unsubscribe` handlers. While a client is subscribed to a model's
 * resource URI, a publisher loop runs for that model's channel and emits a
 * resource-updated notification on each mutation; the client then re-reads the
 * resource. Loops are torn down on unsubscribe and when the server closes.
 *
 * Per-connection: call once per {@link McpServer} instance, **before**
 * `server.connect(...)`. Requires a transport that keeps a server→client stream
 * open (the streamable-HTTP GET stream) — which on serverless/multi-instance
 * hosts means a Durable-Object-backed session. Returns a cleanup function.
 */
export function bridgeModelMutations(
  server: McpServer,
  models: McpModelDef[],
  publisher: MutationPublisher,
  options: BridgeMutationsOptions = {},
): () => void {
  const channelFor = options.channelFormatter ?? defaultChannel;
  const modelByUri = new Map(
    models.map((m) => [modelResourceUri(m.name), m] as const),
  );

  // Advertise subscribe support on top of the listChanged capability that
  // registerResource already set.
  server.server.registerCapabilities({ resources: { subscribe: true } });

  // uri -> controller for the running publisher loop.
  const active = new Map<string, AbortController>();

  function startLoop(uri: string, model: McpModelDef): void {
    if (active.has(uri)) return; // already subscribed
    const controller = new AbortController();
    active.set(uri, controller);
    const channel = channelFor(model.name);
    void (async () => {
      try {
        const stream = publisher.subscribe(channel, {
          signal: controller.signal,
        });
        for await (const _event of stream) {
          // A failed push (e.g. closed stream) must not tear down the loop.
          await server.server.sendResourceUpdated({ uri }).catch(() => {});
        }
      } catch {
        // aborted or transport closed — nothing to do
      }
    })();
  }

  function stopLoop(uri: string): void {
    const controller = active.get(uri);
    if (controller) {
      controller.abort();
      active.delete(uri);
    }
  }

  server.server.setRequestHandler(SubscribeRequestSchema, (request) => {
    const uri = request.params.uri;
    const model = modelByUri.get(uri);
    if (model) startLoop(uri, model);
    return {};
  });

  server.server.setRequestHandler(UnsubscribeRequestSchema, (request) => {
    stopLoop(request.params.uri);
    return {};
  });

  const cleanup = () => {
    for (const controller of active.values()) controller.abort();
    active.clear();
  };

  // Tear down loops when the connection closes, preserving any existing handler.
  const previousOnClose = server.server.onclose;
  server.server.onclose = () => {
    cleanup();
    previousOnClose?.();
  };

  return cleanup;
}
