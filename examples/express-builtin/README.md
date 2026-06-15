# Example: Express + built-in OAuth

MCP server on Express with the built-in OAuth 2.0 + PKCE flow.
No external auth dependency — credentials are validated against a SQLite database
using bcrypt password hashing.

**Test credentials (seeded via `bun run db:seed`):**

| Email | Password |
|---|---|
| `alice@example.com` | `alice1234` |
| `bob@example.com` | `bob12345` |
| `carol@example.com` | `carol123` |

---

## 1. Install & bootstrap

```bash
bun install
bun run db:generate   # zen generate → zenstack/schema.ts + zenstack/mcp-config.ts
bun run db:push       # creates dev.db with all tables
bun run db:seed       # populates 3 users + 4 posts
```

## 2. Start the server

```bash
bun dev
# → http://localhost:3001
```

Verify the OAuth discovery endpoint:

```bash
curl http://localhost:3001/.well-known/oauth-authorization-server
```

---

## 3. Connect from Claude Code (CLI)

```bash
claude mcp add --transport http zenstack-mcp http://localhost:3001
```

Claude Code will open a browser for the OAuth login. Enter the test credentials,
approve, and the token is stored automatically.

Then start a conversation and try:

```
Use the zenstack-mcp tool to list all available models.
```

---

## 4. Connect from Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "zenstack-mcp": {
      "url": "http://localhost:3001"
    }
  }
}
```

Restart Claude Desktop. It will trigger the OAuth flow on first use.

---

## 5. Test the MCP tools manually (curl)

### Step 1 — Get an access token via PKCE

```bash
# Generate a code verifier + challenge (S256)
VERIFIER=$(openssl rand -base64 32 | tr -d '=+/' | head -c 43)
CHALLENGE=$(echo -n "$VERIFIER" | openssl dgst -sha256 -binary | openssl base64 | tr '+/' '-_' | tr -d '=')

# Open the authorize URL in a browser (fills in the login form):
echo "http://localhost:3001/oauth/authorize?client_id=test&redirect_uri=http://localhost:9999/callback&response_type=code&code_challenge=${CHALLENGE}&code_challenge_method=S256"
```

After logging in you'll be redirected to `http://localhost:9999/callback?code=<CODE>`.
Copy `<CODE>`.

```bash
# Exchange the code for a token
curl -s -X POST http://localhost:3001/oauth/token \
  -d "grant_type=authorization_code&code=<CODE>&code_verifier=$VERIFIER&redirect_uri=http://localhost:9999/callback" \
  | jq .
# → { "access_token": "eyJ...", "token_type": "bearer", "expires_in": 3600 }
TOKEN=<access_token from above>
```

### Step 2 — Call the MCP schema tool

```bash
curl -s -X POST http://localhost:3001/ \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": { "name": "schema", "arguments": {} }
  }' | jq .
```

### Step 3 — List all published posts

```bash
curl -s -X POST http://localhost:3001/ \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "execute",
      "arguments": {
        "model": "Post",
        "operation": "findMany",
        "args": { "where": { "published": true } }
      }
    }
  }' | jq .
```
