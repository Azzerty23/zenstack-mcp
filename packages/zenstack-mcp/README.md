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

## License

MIT
