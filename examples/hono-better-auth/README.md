# Example: Hono + better-auth + ZenStack v3 + SQLite

MCP server on Hono that delegates authentication to a [better-auth](https://www.better-auth.com) instance.
The `bearer` plugin lets better-auth validate `Authorization: Bearer <token>` headers — no extra token layer.
Access policies declared in `schema.zmodel` are enforced automatically on every MCP query.

---

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.x
- ZenStack v3 CLI: `bun add -g @zenstackhq/cli` (provides the `zen` command)

---

## 0. Environment variables

Create a `.env` file:

```bash
DB_PATH="./dev.db"
BETTER_AUTH_URL="http://localhost:3000"
BETTER_AUTH_SECRET="change-me-in-production"
```

---

## 1. Generate the schema and push to SQLite

```bash
bun install

# zen generate reads schema.zmodel and outputs:
#   ./zenstack/schema.ts        (ZenStack ORM schema — imported by index.ts)
#   .zenstack/mcp-config.ts     (which models the MCP server exposes)
bun run db:generate

# Push the schema to dev.db (creates all tables including better-auth's)
bun run db:push
```

The generated imports in `index.ts` are already active — `@ts-ignore` suppresses
TypeScript errors until the first generation run.

---

## 2. Start the server

```bash
bun dev
# → http://localhost:3000
```

Verify better-auth is up:

```bash
curl http://localhost:3000/api/auth/ok
# { "ok": true }
```

Verify the OAuth discovery endpoint:

```bash
curl http://localhost:3000/.well-known/oauth-authorization-server
# { "issuer": "http://localhost:3000", "authorization_endpoint": "...", ... }
```

---

## 3. Connect from Claude Code (CLI)

```bash
claude mcp add --transport http zenstack-mcp http://localhost:3000
```

Claude Code reads the discovery document and opens a browser for the better-auth OAuth flow.
After login the token is stored locally — subsequent requests are authenticated automatically.

Start a conversation and try:

```
Use the zenstack-mcp tool to show me the database schema.
```

---

## 4. Connect from Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)  
or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "zenstack-mcp": {
      "url": "http://localhost:3000"
    }
  }
}
```

Restart Claude Desktop. The better-auth OAuth flow is triggered automatically on first use.

---

## 5. Test the MCP tools manually (curl)

### Step 1 — Create an account and get a Bearer token

The `bearer` plugin (declared in `index.ts`) lets the session token be used directly
as an HTTP Bearer token.

```bash
# Create an account (first time only)
curl -s -X POST http://localhost:3000/api/auth/sign-up/email \
  -H "Content-Type: application/json" \
  -d '{"name":"Alice","email":"alice@example.com","password":"s3cr3t"}'

# Sign in and capture the token
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/sign-in/email \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","password":"s3cr3t"}' \
  | jq -r '.token')

echo "TOKEN=$TOKEN"
```

### Step 2 — List models (`schema` tool)

```bash
curl -s -X POST http://localhost:3000/ \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": { "name": "schema", "arguments": {} }
  }' | jq .
```

### Step 3 — Execute a query (`execute` tool)

ZenStack access policies from `schema.zmodel` are enforced automatically — Alice only
sees posts she is allowed to read.

```bash
curl -s -X POST http://localhost:3000/ \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "execute",
      "arguments": {
        "model": "Post",
        "operation": "findMany",
        "args": {
          "where": { "published": true },
          "select": { "id": true, "title": true, "author": { "select": { "email": true } } }
        }
      }
    }
  }' | jq .
```

---

## MCP transports

Both transports are enabled by default (`transport: 'both'`):

| Transport       | Endpoint         | Protocol                    | Best for                        |
|-----------------|------------------|-----------------------------|----------------------------------|
| Streamable HTTP | `POST /`         | JSON-RPC over HTTP          | Claude Code, most MCP clients    |
| SSE             | `GET /sse`       | Server-Sent Events stream   | Legacy / browser-based clients   |

To restrict to a single transport, pass `transport: 'streamable-http'` or `transport: 'sse'`
to `createHonoMcpHandler`.
