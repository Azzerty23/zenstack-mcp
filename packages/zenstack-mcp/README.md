# zenstack-mcp

Turnkey [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server for [ZenStack v3](https://zenstack.dev), with built-in OAuth 2.0 authentication.

Exposes your ZenStack schema as MCP tools (`schema`, `execute`) so AI assistants like Claude can query and mutate your database through your access-control policies.

## Installation

```bash
npm install zenstack-mcp
# or
bun add zenstack-mcp
```

## Quick Start

### With Hono (built-in OAuth)

```typescript
import { Hono } from 'hono'
import { createHonoMcpHandler } from 'zenstack-mcp/server-adapters/hono'
import { schema } from '~/zenstack/schema'
import { db } from '~/db'
import { PolicyPlugin } from '@zenstackhq/plugin-policy'
import bcrypt from 'bcryptjs'

const app = new Hono()

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

app.route('/', oauthRoutes)    // /.well-known/*, /oauth/*, /login, /register
app.route('/mcp', mcpMiddleware)

export default app
```

### With Express (built-in OAuth)

```typescript
import express from 'express'
import { createExpressMcpHandler } from 'zenstack-mcp/server-adapters/express'
import { schema } from '~/zenstack/schema'

const app = express()

const { oauthRoutes, mcpMiddleware } = createExpressMcpHandler({
  schema,
  auth: {
    validateCredentials: async (email, password) => { /* ... */ },
    jwtSecret: process.env.JWT_SECRET!,
  },
  getClient: async (user) => db.withPolicy(new PolicyPlugin({ user })),
})

app.use(oauthRoutes)           // /.well-known/*, /oauth/*, /login, /register
app.use('/mcp', mcpMiddleware)
```

### With better-auth

```typescript
import { betterAuthMcpAdapter } from 'zenstack-mcp/auth-adapters/better-auth'

app.route('/mcp', createHonoMcpHandler({
  schema,
  auth: betterAuthMcpAdapter(myBetterAuthInstance),
  getClient: async (user) => db.withPolicy(new PolicyPlugin({ user })),
}))
```

## ZenStack Plugin

Use the `@@mcp` attribute to control which models are exposed to AI assistants.

In your `schema.zmodel`:

```zmodel
plugin mcp {
  provider = 'zenstack-mcp'
  output   = './zenstack'
}

model User {
  id    String @id @default(cuid())
  email String @unique
  // exposed to MCP by default
}

model AuditLog {
  id String @id
  // hide sensitive models from AI assistants
  @@mcp(false)
}
```

Run `zen generate` to produce `./zenstack/mcp-config.ts`, then pass it to the handler:

```typescript
import { mcpConfig } from '~/zenstack/mcp-config'

app.route('/mcp', createHonoMcpHandler({ schema, mcpConfig, auth: ..., getClient: ... }))
```

## MCP Tools

The server exposes three tools to connected AI clients:

| Tool | Description |
|------|-------------|
| `schema` | Returns the ZenStack schema so the AI understands your data model |
| `execute` | Runs a Prisma-compatible query through your policy-enforced client — access-control policies are validated automatically before execution |
| `me` | Returns the authenticated user for the current request |

## API Reference

### `createHonoMcpHandler(config)` / `createExpressMcpHandler(config)`

| Option | Type | Description |
|--------|------|-------------|
| `schema` | `Schema` | Your ZenStack schema object |
| `auth` | `McpAuthAdapter \| McpBuiltInAuthOptions` | Auth adapter or built-in config |
| `getClient` | `(user) => Promise<PrismaClient>` | Returns a policy-enforced Prisma client for the authenticated user |
| `mcpConfig` | `McpConfig` (optional) | Generated config from the ZenStack plugin |

### `betterAuthMcpAdapter(auth)`

Wraps a [better-auth](https://better-auth.com) instance as an `McpAuthAdapter`.

OAuth client registration only accepts `https://` redirect URIs, plus loopback
`http://localhost` / `http://127.0.0.1` / `http://[::1]` callbacks for local development.

### `getRequestUser()`

Returns the currently authenticated user from within a request handler.

```typescript
import { getRequestUser } from 'zenstack-mcp'

const user = getRequestUser()
```

### `createInMemoryTokenStore()`

Creates a default in-memory token store. Replace with a persistent implementation for production.

## Security

Read this before deploying — two points are easy to get wrong and both bypass data protection silently.

### `getClient` **must** return a policy-enforced (enhanced) client

The `execute` tool runs the operation it is given directly on whatever `getClient` returns.
**All data-access authorization lives in your ZenStack access policies, enforced by the
enhanced client — not in this package.** If `getClient` returns a *raw* ORM client, every
authenticated user gets unrestricted read/write access to your entire database through `execute`.

```typescript
// ✅ Correct — policies are enforced
getClient: async (user) => db.withPolicy(new PolicyPlugin({ user }))

// ❌ Wrong — NO access control: every authenticated caller can read/write everything
getClient: async (user) => db
```

When `getClient` is called outside an authenticated context the user is `undefined`, which
ZenStack treats as an anonymous caller — so your policies must also be correct for the
anonymous case (`@@allow('read', true)` etc.).

### Model exposure is *not* an authorization boundary

`@@mcp(false)`, `mcpConfig`, `include`, `exclude` and `modelOperations` only reduce the surface
the MCP tools *advertise*. They do **not** restrict what the database can return:

- A model hidden from MCP is still reachable through a relation `include`/`select` from an
  exposed model (subject to your policies).
- These options are a usability/ergonomics filter, not a security control.

**Always enforce real protection with ZenStack access policies.** Treat exposure config as
"what the AI sees first", and policies as "what the AI is actually allowed to touch".

### Other hardening options

| Option | Recommendation |
|--------|----------------|
| `requireWhereForBulk: true` | Enable in production — rejects `deleteMany`/`updateMany` with an empty `where`, so an LLM can't wipe a whole table. |
| `initialAccessToken` | Set for the built-in OAuth server — otherwise `/register` is open to anyone. Registered clients also expire after `clientTtl` (default 24h) to prevent registry exhaustion. |
| `allowedOrigins` | Set when the server may be reached from a browser — rejects requests from any other `Origin` (DNS-rebinding protection). Native clients send no `Origin` and are unaffected. |
| `jwtSecret` / better-auth `secret` | Must be ≥ 32 characters (enforced). Use a high-entropy random value. |
| `transport` | Keep the default `"streamable-http"` for serverless/multi-instance hosts. `"sse"`/`"both"` keeps sessions in per-instance memory and **only works on a single instance**. |
| better-auth stateless mode | Access tokens (default 1h) and refresh tokens are **not** individually revocable until they expire — revoking the underlying better-auth session is caught only at refresh time. Use short TTLs, `stateful: true` for immediate revocation (single-instance), or pass `refreshTokenReuse` to make refresh tokens one-time-use (rotation with stolen-token replay detection). |

## License

MIT
