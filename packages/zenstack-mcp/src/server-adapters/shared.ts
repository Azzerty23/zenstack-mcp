/**
 * Framework-agnostic auth pipeline shared by the Hono and Express adapters.
 * The security-critical request gate (Origin allowlist, Bearer parsing,
 * token validation with audience context) lives here so a fix applies to
 * every transport at once; the adapters only translate requests/responses.
 */
import type { SchemaDef } from "@zenstackhq/schema";
import type {
  McpAuthAdapter,
  McpBuiltInAuthOptions,
  McpServerConfig,
} from "../types.js";
import {
  builtInMcpAuth,
  isBuiltInAuthOptions,
} from "../auth-adapters/oauth/index.js";
import { isOriginAllowed } from "./origin.js";

export function resolveAuthAdapter(
  auth: McpAuthAdapter | McpBuiltInAuthOptions,
): McpAuthAdapter {
  return isBuiltInAuthOptions(auth) ? builtInMcpAuth(auth) : auth;
}

export interface McpRequestAuthInput {
  /** `scheme://host[:port]` the request was received on. */
  origin: string;
  /** Raw `Origin` header, if any (only browsers send one). */
  originHeader?: string;
  /** Raw `Authorization` header, if any. */
  authorization?: string;
}

export type McpRequestAuthResult =
  | { ok: true; user: unknown }
  | {
      ok: false;
      status: 401 | 403;
      headers: Record<string, string>;
      body: { error: string; error_description?: string };
    };

/**
 * Runs the full MCP request gate: DNS-rebinding Origin check, Bearer token
 * presence, then token validation with the request origin as audience context
 * (RFC 8707 — the adapter rejects tokens minted for another server).
 *
 * Unauthenticated responses carry the `WWW-Authenticate` header pointing at
 * the protected-resource metadata so clients can discover the authorization
 * server (MCP Authorization spec / RFC 9728).
 */
export async function authenticateMcpRequest(
  authAdapter: McpAuthAdapter,
  allowedOrigins: McpServerConfig<SchemaDef>["allowedOrigins"],
  req: McpRequestAuthInput,
): Promise<McpRequestAuthResult> {
  if (!isOriginAllowed(req.originHeader, allowedOrigins)) {
    return {
      ok: false,
      status: 403,
      headers: {},
      body: { error: "forbidden", error_description: "Origin not allowed" },
    };
  }

  const wwwAuthenticate = `Bearer resource_metadata="${req.origin}/.well-known/oauth-protected-resource"`;

  if (!req.authorization?.startsWith("Bearer ")) {
    return {
      ok: false,
      status: 401,
      headers: { "WWW-Authenticate": wwwAuthenticate },
      body: {
        error: "unauthorized",
        error_description: "Bearer token required",
      },
    };
  }

  try {
    const token = req.authorization.slice(7);
    const user = await authAdapter.validateToken(token, { origin: req.origin });
    return { ok: true, user };
  } catch {
    return {
      ok: false,
      status: 401,
      headers: { "WWW-Authenticate": wwwAuthenticate },
      body: { error: "invalid_token" },
    };
  }
}
