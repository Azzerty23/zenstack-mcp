# zenstack-mcp

ZenStack → MCP in under 10 lines of code

Expose your [ZenStack v3](https://zenstack.dev) database to LLM like Claude — with access-control policies enforced on every query, and OAuth 2.0 authentication handled out of the box.

```typescript
const { oauthRoutes, mcpMiddleware } = createHonoMcpHandler({
  schema,
  auth: { validateCredentials, jwtSecret: process.env.JWT_SECRET! },
  getClient: async (user) => db.withPolicy(new PolicyPlugin({ user })),
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
             │  db.withPolicy(new PolicyPlugin({ user }))
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
  getClient: async (user) => db.withPolicy(new PolicyPlugin({ user })),
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
