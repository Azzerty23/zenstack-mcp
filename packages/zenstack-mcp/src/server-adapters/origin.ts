import type { SchemaDef } from "@zenstackhq/schema";
import type { McpServerConfig } from "../types.js";

/**
 * Returns true if a request bearing `origin` is permitted under `allowedOrigins`.
 *
 * A missing Origin header is always allowed: native MCP clients (Claude Desktop,
 * CLIs) don't send one, so the check only constrains browser-originated requests
 * — which is exactly the DNS-rebinding threat the allowlist defends against.
 */
export function isOriginAllowed(
  origin: string | undefined,
  allowedOrigins: McpServerConfig<SchemaDef>["allowedOrigins"],
): boolean {
  if (!allowedOrigins) return true;
  if (!origin) return true;
  return typeof allowedOrigins === "function"
    ? allowedOrigins(origin)
    : allowedOrigins.includes(origin);
}
