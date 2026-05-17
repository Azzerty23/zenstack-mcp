import type { McpAuthAdapter, McpBuiltInAuthOptions } from "../../types.js";
import { mountOAuthRoutes } from "./oauth-server.js";
import { verifyToken } from "./jwt.js";

export function builtInMcpAuth(options: McpBuiltInAuthOptions): McpAuthAdapter {
  if (options.jwtSecret.length < 32) {
    throw new Error('zenstack-mcp: jwtSecret must be at least 32 characters for HS256 security')
  }
  return {
    mountRoutes: (router) => mountOAuthRoutes(router, options),
    validateToken: (token: string) => verifyToken(token, options.jwtSecret),
  };
}

export function isBuiltInAuthOptions(
  auth: unknown,
): auth is McpBuiltInAuthOptions {
  return (
    typeof auth === "object" && auth !== null && "validateCredentials" in auth
  );
}
