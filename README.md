# zenstack-mcp

ZenStack → MCP in under 10 lines of code

Expose your [ZenStack v3](https://zenstack.dev) database to LLM like Claude — with access-control policies enforced on every query, and OAuth 2.0 authentication handled out of the box.

```typescript
const { oauthRoutes, mcpMiddleware } = createHonoMcpHandler({
  schema,
  auth: { validateCredentials, jwtSecret: process.env.JWT_SECRET! },
  getClient: async (user) => db.$use(new PolicyPlugin()).$setAuth({ id: user.id }),
})

app.route('/', oauthRoutes)   // OAuth 2.0 + PKCE flows
app.route('/mcp', mcpMiddleware)
```

```bash
claude mcp add --transport http zenstack-mcp http://localhost:3000
```

That's it — Claude can now query and mutate your database, and your ZenStack policies decide what each user can see or do.

---

## Why

AI assistants need structured access to your data. Giving them raw database access is unsafe; building a custom API for each use-case is slow. `zenstack-mcp` bridges the gap:

- **Policy-enforced queries** — every MCP call goes through your ZenStack access-control rules, the same ones protecting your regular API
- **Standard auth** — OAuth 2.0 + PKCE built in, so Claude Code and Claude Desktop authenticate with a browser flow and store tokens automatically
- **Schema-aware** — the `schema` tool gives the AI your full data model; it asks better questions and writes better queries
- **Zero boilerplate** — one function call wires up the MCP server, OAuth endpoints, and policy enforcement

---

## How it works

```
Claude (MCP client)
      │  OAuth 2.0 + PKCE
      ▼
┌─────────────────────────────┐
│  zenstack-mcp server        │
│                             │
│  • schema tool              │  ← returns your ZenStack data model
│  • execute tool             │  ← runs Prisma queries through policies
│  • me tool                  │  ← returns the authenticated user
└────────────┬────────────────┘
             │  db.$use(new PolicyPlugin()).$setAuth({ id: user.id })
             ▼
┌─────────────────────────────┐
│  ZenStack enhanced client   │  ← access-control policies enforced here
└────────────┬────────────────┘
             │
             ▼
        Your database
```

Each request is authenticated, the user is resolved from the token, and the ZenStack client is scoped to that user before any query runs. Policies declared in your `.zmodel` file are evaluated automatically — no extra code needed.

---

## Monorepo structure

```
packages/
  zenstack-mcp/          # Core library — install this in your project
examples/
  express-builtin/       # Express + built-in OAuth 2.0 + PKCE
  hono-better-auth/      # Hono + better-auth (bearer token)
```

### `packages/zenstack-mcp`

The publishable package. Provides:

- `createHonoMcpHandler` / `createExpressMcpHandler` — one-call server setup
- Built-in OAuth 2.0 + PKCE (login page, token endpoint, PKCE validation)
- `betterAuthMcpAdapter` — plug in an existing [better-auth](https://better-auth.com) instance
- `@@mcp(false)` plugin attribute — hide sensitive models from AI clients
- `getRequestUser()` — access the authenticated user from any handler

→ See [`packages/zenstack-mcp/README.md`](packages/zenstack-mcp/README.md) for the full API reference.

### `examples/express-builtin`

Minimal Express server with the built-in OAuth flow. Good starting point if you don't already have an auth layer.

→ See [`examples/express-builtin/README.md`](examples/express-builtin/README.md)

### `examples/hono-better-auth`

Hono server that delegates auth to a better-auth instance. The `bearer` plugin lets the session token be used directly as a `Bearer` header — no extra token layer.

→ See [`examples/hono-better-auth/README.md`](examples/hono-better-auth/README.md)

---

## Quickstart

### 1. Install

```bash
bun add zenstack-mcp
# or
npm install zenstack-mcp
```

### 2. Add the MCP server

```typescript
// With Hono
import { createHonoMcpHandler } from 'zenstack-mcp/server-adapters/hono'
import { schema } from '~/zenstack/schema'
import { db } from '~/db'
import { PolicyPlugin } from '@zenstackhq/plugin-policy'

const { oauthRoutes, mcpMiddleware } = createHonoMcpHandler({
  schema,
  auth: {
    validateCredentials: async (email, password) => {
      const user = await db.user.findUnique({ where: { email } })
      if (!user || !await bcrypt.compare(password, user.passwordHash)) return null
      return user
    },
    jwtSecret: process.env.JWT_SECRET!,
  },
  getClient: async (user) => db.$use(new PolicyPlugin()).$setAuth({ id: user.id }),
})

app.route('/', oauthRoutes)
app.route('/mcp', mcpMiddleware)
```

### 3. (Optional) Control which models are exposed

```zmodel
// schema.zmodel
plugin mcp {
  provider = 'zenstack-mcp'
  output   = './zenstack'
}

model AuditLog {
  id String @id
  @@mcp(false)   // hidden from AI clients
}
```

Run `zen generate`, then pass `mcpConfig` to the handler.

### 4. Connect Claude

```bash
# Claude Code CLI
claude mcp add --transport http zenstack-mcp http://localhost:3000
```

Or add to `claude_desktop_config.json` for Claude Desktop.

---

## Customization

### Custom login page

By default, the built-in OAuth flow serves a minimal login page. Replace it with your own HTML:

```typescript
import { readFile } from 'fs/promises'

createHonoMcpHandler({
  auth: {
    // String
    loginPage: '<html>...</html>',
    // Or an async function (fetched from disk, a CMS, etc.)
    loginPage: () => readFile('./login.html', 'utf-8'),
    validateCredentials,
    jwtSecret: process.env.JWT_SECRET!,
  },
  // ...
})
```

The login script is injected automatically before `</body>`. Your HTML must expose these element IDs so the script can wire up the form:

| ID | Element | Purpose |
|----|---------|---------|
| `login-form` | `<form>` | Submit listener |
| `email` | `<input type="email">` | Email field |
| `password` | `<input type="password">` | Password field |
| `login-button` | `<button type="submit">` | Disabled during submission |
| `error-container` | any element | Displays error messages (hidden by default) |

If you need to inject the script yourself (e.g. with a CSP nonce), import it directly:

```typescript
import { loginScript } from 'zenstack-mcp'

const html = `<html>
  ...
  <script nonce="${nonce}">${loginScript}</script>
</body></html>`
```

---

### Restrict exposed models

**Via code** — `include` / `exclude` accept model name lists:

```typescript
createHonoMcpHandler({
  schema,
  include: ['Post', 'Comment'],  // only these models
  // or
  exclude: ['AuditLog', 'Session'],
  // ...
})
```

**Via ZenStack plugin** — annotate models in `schema.zmodel` with `@@mcp(false)`, then pass the generated config:

```zmodel
plugin mcp {
  provider = 'zenstack-mcp'
  output   = './zenstack'
}

model AuditLog {
  id String @id
  @@mcp(false)   // hidden from AI clients
}
```

```typescript
import { mcpConfig } from '~/zenstack/mcp-config'

createHonoMcpHandler({ schema, mcpConfig, ... })
```

---

### Restrict operations per model

Whitelist which Prisma operations the AI can call on each model:

```typescript
createHonoMcpHandler({
  schema,
  modelOperations: {
    Post: ['findMany', 'findUnique', 'create'],  // no update / delete
    User: ['findMany', 'findUnique'],             // read-only
  },
  // ...
})
```

---

### Prevent bulk operations without a WHERE

Enable `requireWhereForBulk` to reject `deleteMany` / `updateMany` calls that have no (or empty) `where` clause. Useful as a safety net against LLMs accidentally wiping entire tables:

```typescript
createHonoMcpHandler({
  schema,
  requireWhereForBulk: true,
  // ...
})
```

---

### Token TTL and token store

```typescript
createHonoMcpHandler({
  schema,
  auth: {
    validateCredentials,
    jwtSecret: process.env.JWT_SECRET!,
    tokenTtl: 900,             // access token TTL — 15 min (default: 3600)
    refreshTokenTtl: 604800,   // refresh token TTL — 7 days (default: 30 days)
    tokenStore: myRedisStore,  // custom store for multi-process / serverless
  },
  // ...
})
```

`tokenStore` must implement the `TokenStore` interface (see [`packages/zenstack-mcp/README.md`](packages/zenstack-mcp/README.md)). The default in-memory store is not suitable for multi-process or serverless deployments.

---

### Protect the registration endpoint

By default anyone can `POST /register` to obtain a `client_id`. In production, require an initial access token:

```typescript
createHonoMcpHandler({
  auth: {
    validateCredentials,
    jwtSecret: process.env.JWT_SECRET!,
    initialAccessToken: process.env.MCP_REGISTRATION_SECRET!,
    maxClients: 50,  // hard cap on registered clients (default: 100)
  },
  // ...
})
```

MCP clients must then send `Authorization: Bearer <initialAccessToken>` when registering.

---

### MCP transport (Hono only)

```typescript
createHonoMcpHandler({
  schema,
  transport: 'both',  // 'streamable-http' (default) | 'sse' | 'both'
  // ...
})
```

| Transport | Endpoint | Best for |
|-----------|----------|----------|
| `streamable-http` | `POST /mcp/` | Claude Code, most MCP clients |
| `sse` | `GET /mcp/sse` | Legacy / browser-based clients |
| `both` | both above | Maximum compatibility |

> Express only supports `streamable-http`. Use the Hono adapter for SSE.

---

## Serverless & Cloudflare Workers

Two things matter when you deploy on a multi-instance / serverless runtime (Cloudflare Workers, Lambda, autoscaled containers): how the better-auth instance is obtained, and how its database connections behave across requests.

### The auth source: captured instance vs per-request factory

`createHonoMcpHandler` builds its OAuth + MCP routes once at startup — there is no per-request hook to rebuild the handler. But `betterAuthMcpAdapter` accepts the auth in **two** forms that differ in *when* the better-auth instance is materialized.

**A captured instance** — created once at module load:

```typescript
const auth = betterAuth({ /* ... */, secret: process.env.BETTER_AUTH_SECRET })

const { oauthRoutes, mcpMiddleware } = createHonoMcpHandler({
  schema,
  mcpConfig,
  auth: betterAuthMcpAdapter(auth),          // ← reused for the isolate's lifetime
  getClient: async (user) => createUserDb(user.id),
})
```

**A per-request factory** — pass `getAuth` plus the static `baseURL` / `secret`. `getAuth` is invoked to build a fresh instance **only** when a better-auth API call is actually needed (`signInEmail` on login, `getSession` on refresh / stateful validate) — never on the stateless `validateToken` hot path:

```typescript
const { oauthRoutes, mcpMiddleware } = createHonoMcpHandler({
  schema,
  mcpConfig,
  auth: betterAuthMcpAdapter({
    getAuth: () => createAuth(createDb()),   // ← fresh, request-scoped db each call
    baseURL: process.env.BETTER_AUTH_URL!,
    secret: process.env.BETTER_AUTH_SECRET!,
  }),
  getClient: async (user) => createUserDb(user.id),
})
```

The captured instance is a small performance win — `validateToken` runs on *every* tool call, and reusing the instance avoids repaying better-auth's setup cost (key imports, JWT signing, rebuilding the plugin chain). But that instance, and any DB connection it holds, lives for the whole isolate — which runs into the workerd rule below.

The factory form trades that micro-optimization for a cleaner lifetime: the only DB work happens inside the request that called `getAuth`, with a request-scoped client, so nothing outlives the request. **On serverless, prefer the factory form** — it sidesteps the gotcha below entirely. (In stateless mode `validateToken` is pure crypto and calls neither `getAuth` nor the database, so the hot path stays cheap either way.)

### Multi-user safety — `getClient` must be a pure factory of `user`

Whichever auth form you use, **no caller identity ever flows through it.** A shared server is safe across users only because identity is strictly per-request:

1. Each request presents its own token → `validateToken` returns the user **encoded in that token** (pure crypto in stateless mode — a user can only ever obtain the identity signed into their own token).
2. That user is stored in a per-request [`AsyncLocalStorage`](https://nodejs.org/api/async_context.html) context (`requestContext.run({ user }, …)`), so concurrent requests never see each other's user.
3. The `execute` tool reads `getRequestUser()` from *its* context and calls `getClient(user)` — which must return a **fresh, policy-scoped** client every time.

The singleton holds no per-user state; the only mutable thing the requests share is the auth machinery, which is request-driven (input in, result out). That is exactly why better-auth is designed to be a singleton.

The one thing that breaks this is making `getClient` return anything that isn't scoped to the `user` argument:

```typescript
// ✅ a fresh, per-user, policy-scoped client on every call
getClient: async (user) =>
  createDb().$use(new PolicyPlugin()).$setAuth({ id: user.id })

// ❌ returns the raw singleton client — NO policies, every user sees everything
getClient: async () => longLivedDb

// ❌ caches one client across requests — leaks whichever user set it last
let shared
getClient: async (user) => (shared ??= createDb().$use(new PolicyPlugin()).$setAuth(user))
```

| Rule | Why |
|------|-----|
| Build the client from the `user` argument, every call | Scopes ZenStack policies (`auth().id` / `auth().role`) to the caller |
| Never reuse / memoize the returned client across requests | A cached client carries the previous caller's `$setAuth` identity |
| Never expose the singleton's raw (unscoped) auth client via `getClient` | It bypasses policies entirely |
| Hide auth tables with `@@mcp(false)` | Keeps `Session` / `Account` / `Verification` off the AI surface |

> ZenStack's `$setAuth` returns a **new** client instance rather than mutating in place, so building per request is cheap and never races with a concurrent request.

### The workerd I/O gotcha (captured-instance form only)

On Cloudflare Workers (workerd) there is a hard runtime rule:

> An I/O object — including a database connection/socket — created in the context of one request **cannot be reused by a later request.** Doing so aborts with *"Cannot perform I/O on behalf of a different request."*

If you use the **factory form** above, this doesn't apply: `getAuth` builds its db inside the request that needs it, so the connection is born and dies in one request — exactly like the per-request client your `getClient` returns. You're done.

It only bites the **captured-instance** form: that instance holds one db client (the one you passed to `betterAuth({ database })`) for the whole isolate. A normal connection pool keeps sockets alive between requests, so the second request that checks out a pooled connection inherits one bound to the *first* request's I/O context — and workerd kills it. If you must keep a captured instance, give its client a pool that never carries a connection across requests:

```typescript
import { Pool } from 'pg'

// Safe to hold for the whole isolate lifetime: maxUses:1 destroys each connection
// right after it is released, so no socket is ever reused by a different request.
const longLivedPool = new Pool({
  connectionString,
  maxUses: 1,
  idleTimeoutMillis: 1,
})
```

> **Use `maxUses: 1` *only* on a long-lived client — never on your per-request ones.** It is a deliberate de-optimization: destroying the connection on release forces a brand-new connection **per query** instead of reusing one across the queries in a request. On a long-lived client that's touched rarely (e.g. an MCP auth singleton) the cost is negligible and worth the safety. On your hot per-request clients (the one `getClient` builds, your API handlers, etc.) it is pure overhead for *zero* safety gain — those clients already can't reuse a socket across requests, because their whole pool is born and dies inside one request. Leave them on the default pool so multiple queries in a request share one connection.

`maxUses: 1` is independent of which transport you pick — it just guarantees no socket outlives the request that opened it. Choose a Workers-compatible transport for that pool:

- **Hyperdrive + a standard driver (`node-postgres` / `Postgres.js`)** — what [Neon officially recommends](https://neon.com/blog/hyperdrive-neon-faq) for Workers. Point the pool at `env.HYPERDRIVE.connectionString`; Hyperdrive keeps its own global pool to your database, so each new local socket still avoids the expensive Neon-side connection (you pay a cheap local handshake per query, not a full DB connect — fine for a rarely-touched long-lived client). Do **not** combine Hyperdrive with the Neon serverless driver (it speaks WebSocket/HTTP, not the TCP Hyperdrive proxies) or with Neon's `-pooler` endpoint (redundant — Hyperdrive already pools).
- **[Neon serverless driver](https://neon.tech/docs/serverless/serverless-driver)** — the alternative when you're *not* using Hyperdrive. It tunnels over WebSocket/fetch (which workerd supports, unlike raw TCP sockets) and connects straight to Neon. Its `Pool` is still a real pool, so set the same `maxUses: 1`.

```typescript
// Recommended on Workers when you have Hyperdrive:
import { Pool } from 'pg'
const longLivedPool = new Pool({
  connectionString: env.HYPERDRIVE.connectionString,
  maxUses: 1,
  idleTimeoutMillis: 1,
})
```

> Either way, the rule is the same: a long-lived (singleton) DB client on workerd must not reuse a connection across requests.

> In stateless mode the singleton's DB is barely touched — only `signInEmail` during the interactive login hits it (`validateToken` is crypto-only) — but that one path is enough to trigger the error, so the long-lived client still needs the connection-per-request pool.

### Keep OAuth state out of memory

On multiple instances, `/register` and `/oauth/authorize` can land on different instances. Set a `secret` on your better-auth config (`BETTER_AUTH_SECRET`) so `betterAuthMcpAdapter` runs in **stateless mode** — `client_id`s are HMAC-signed and PKCE codes are encrypted into the code itself, so no shared in-memory map is needed. See [`packages/zenstack-mcp/README.md`](packages/zenstack-mcp/README.md) for the stateful/stateless trade-offs.

> For the same reason, stick to the default `streamable-http` transport on Workers. `sse` stores sessions in a per-instance in-memory map and breaks across instances.

---

## Development

```bash
bun install
bun run build           # build all packages
bun test                # run tests (bun test)
```

To run an example:

```bash
cd examples/hono-better-auth
bun install
bun run db:generate && bun run db:push
bun dev
```

---

## License

MIT
