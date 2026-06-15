# Realtime: publishing mutations & MCP resource notifications

zenstack-mcp can feed a **single** pub/sub source of truth so that data changes
reach both:

- your app's realtime SSE subscriptions (e.g. `@viiite/server` + `@viiite/client`), and
- MCP clients (the LLM), via `notifications/resources/updated`.

There is **one** publisher, not two. Pass the same instance your app already
uses — including a Durable-Object-backed one on Cloudflare Workers.

```
                       ┌──────────────────────────────┐
   App write ─────────▶│  Publisher<ModelMutationEvent>│◀──── MCP write (execute tool)
   (viiite ops)        │  channel = model.toLowerCase  │      [piece 1]
                       └──────────┬───────────┬────────┘
                                  │           │
                 oRPC SSE ────────┘           └──────── MCP bridge [piece 2]
                 (@viiite/client)             resources/updated → LLM client
```

## Piece 1 — publish mutations from the MCP `execute` tool (runtime-agnostic)

Set `publisher` on the server config. After every successful write the `execute`
tool publishes a `ModelMutationEvent` on `channelFormatter(model)` (default
`model.toLowerCase()`, matching `@viiite/server`).

```ts
import { createHonoMcpHandler } from "@zenstackhq/mcp/server-adapters/hono";

const { oauthRoutes, mcpMiddleware } = createHonoMcpHandler({
  schema,
  auth,
  getClient,
  // The SAME publisher your @viiite/server router uses (single source of truth).
  publisher: myPublisher, // e.g. the @viiite/server Publisher (Durable-Object-backed)
  // channelFormatter defaults to model.toLowerCase() — override to match a custom one.
});
```

That's all that's needed for your **app** subscribers to observe writes the LLM
makes through MCP. It works on the stateless `streamable-http` transport (and
therefore on Cloudflare Workers) because publishing is fire-and-forget; it never
requires the MCP server to hold a stream.

## Piece 2 — push `resources/updated` to the MCP (LLM) client

This pushes change notifications **over the MCP protocol**, so it requires a
**stateful** transport that keeps the streamable-HTTP `GET` stream open for the
session. On a single long-running process that can be an in-memory session; on
**Cloudflare Workers (multi-isolate) it must be a Durable Object** that owns the
session + stream (e.g. the `agents` SDK `McpAgent`). The in-memory session map in
the Hono `sse`/`both` transport is single-instance only.

### Cloudflare Workers adapter (`server-adapters/workers`)

The adapter wraps the `agents` SDK `McpAgent` (the Durable Object that owns the
session + stream) and `@cloudflare/workers-oauth-provider` (OAuth). It builds the
ZenStack MCP server inside the DO and turns on resources + the mutation bridge
automatically when a `publisher` is provided.

Install the optional peers in your worker: `agents`,
`@cloudflare/workers-oauth-provider`.

```ts
import { createWorkersMcpHandler } from "@zenstackhq/mcp/server-adapters/workers";
import { schema } from "./zenstack/schema";
import { loginHandler } from "./auth"; // your Better Auth login/consent worker

const { handler, Agent } = createWorkersMcpHandler({
  schema,
  getClient: (user) => getEnhancedClient(user),
  // OAuthProvider authenticates first and passes the grant as props.
  resolveUser: (props) => props.user as AuthType<typeof schema>,
  publisher: env.PUBLISHER,         // your Durable-Object-backed publisher
  binding: "ZEN_STACK_MCP",         // matches the wrangler DO binding below
  defaultHandler: loginHandler,     // app-specific OAuth login UI
});

// Bind the DO class under the same name as `binding`, and serve the provider.
export { Agent as ZEN_STACK_MCP };
export default handler;
```

`wrangler.toml`:

```toml
[[durable_objects.bindings]]
name = "ZEN_STACK_MCP"
class_name = "ZEN_STACK_MCP"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["ZEN_STACK_MCP"]
```

Need only the Durable Object class (own OAuth wiring)? Use
`createZenStackMcpAgent(options)` and mount it with
`Agent.serve("/mcp", { binding })`.

> The adapter resolves the user from the OAuth **props** (not the request
> context) — the Durable Object has no per-request AsyncLocalStorage. Your
> `getClient` is called with the user from `resolveUser(props)`.

### Building blocks (advanced / non-Cloudflare stateful hosts)

The adapter is assembled from two runtime-agnostic helpers you can wire into any
stateful session **before** `server.connect(...)`:

```ts
import { buildMcpServer, extractModels } from "@zenstackhq/mcp/server";
import {
  registerModelResources,
  bridgeModelMutations,
} from "@zenstackhq/mcp";

const models = extractModels(config);
const server = buildMcpServer(models, config);

// 1. Expose each model as a subscribable resource (zenstack://<Model>).
registerModelResources(server, models, config.getClient);

// 2. Bridge publisher mutations → notifications/resources/updated while the
//    client is subscribed. Returns a cleanup() you can also call on teardown.
const cleanup = bridgeModelMutations(server, models, config.publisher!, {
  channelFormatter: config.channelFormatter,
});

await server.connect(transport); // streamable-HTTP transport with sessionId set
// ... on session end: cleanup() (also runs automatically on server.onclose)
```

Flow once connected:

1. Client calls `resources/list` → sees `zenstack://Post`, `zenstack://User`, …
2. Client calls `resources/subscribe { uri: "zenstack://Post" }`.
3. A publisher loop starts for channel `post`. On each `ModelMutationEvent`, the
   server sends `notifications/resources/updated { uri: "zenstack://Post" }`.
4. The client re-reads the resource (`resources/read`), which runs an
   auth-enforced `findMany`.
5. `resources/unsubscribe` (or session close) stops the loop.

### Why a Durable Object on Workers

The streamable-HTTP `GET` stream is bound to one session: the SDK transport
validates `mcp-session-id`, and the `McpServer` instance must live as long as the
stream. Across Workers isolates an in-memory session map can't satisfy this — the
POST `initialize` and the `GET` stream may land on different isolates. A Durable
Object pins the session (and can subscribe to your `PublisherDurableObject`),
which is exactly what `McpAgent` provides.

## ModelMutationEvent shape

Structurally identical to `@viiite/server`'s, so the same event flows through one
publisher:

```ts
interface ModelMutationEvent<T = unknown> {
  operation: "create" | "update" | "delete";
  modelName: string;            // PascalCase, e.g. "Post"
  data?: T;                     // the record, for single-record writes
  ids?: (string | number)[];   // affected ids when derivable
  timestamp: number;
}
```

The `execute` tool maps: `create`/`createMany` → `create`,
`update`/`updateMany`/`upsert` → `update`, `delete`/`deleteMany` → `delete`.
Bulk operations carry no `data` (they return `{ count }`); `ids` are taken from
the result, falling back to the `where` clause.
