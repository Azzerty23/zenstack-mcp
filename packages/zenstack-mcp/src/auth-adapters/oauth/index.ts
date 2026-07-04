import type { McpAuthAdapter, McpBuiltInAuthOptions } from "../../types.js";
import { mountOAuthRoutes } from "./oauth-server.js";
import { verifyToken } from "./jwt.js";

export function builtInMcpAuth(options: McpBuiltInAuthOptions): McpAuthAdapter {
  if (options.jwtSecret.length < 32) {
    throw new Error('zenstack-mcp: jwtSecret must be at least 32 characters for HS256 security')
  }
  return {
    mountRoutes: (router) => mountOAuthRoutes(router, options),
    // RFC 8707 audience binding: only accept tokens minted for this server —
    // the configured `resource`, or failing that the origin the MCP request
    // arrived on (passed by the transport adapters). Without an expected
    // audience (direct call with no ctx), only signature/expiry are checked.
    validateToken: (token, ctx) =>
      verifyToken(token, options.jwtSecret, options.resource ?? ctx?.origin),
  };
}

export function isBuiltInAuthOptions(
  auth: unknown,
): auth is McpBuiltInAuthOptions {
  return (
    typeof auth === "object" && auth !== null && "validateCredentials" in auth
  );
}
