/**
 * Unit tests for the shared MCP request gate used by both the Hono and the
 * Express adapters (Origin allowlist → Bearer parsing → token validation with
 * audience context).
 */
import { describe, expect, test } from "bun:test";

import { authenticateMcpRequest, resolveAuthAdapter } from "../server-adapters/shared.js";
import type { McpAuthAdapter, McpTokenValidationContext } from "../types.js";

const ORIGIN = "https://server.example";

function adapterReturning(user: unknown): McpAuthAdapter {
  return { mountRoutes: () => {}, validateToken: async () => user };
}

describe("authenticateMcpRequest", () => {
  test("valid Bearer token authenticates and forwards the request origin as context", async () => {
    let seenCtx: McpTokenValidationContext | undefined;
    let seenToken: string | undefined;
    const adapter: McpAuthAdapter = {
      mountRoutes: () => {},
      validateToken: async (token, ctx) => {
        seenToken = token;
        seenCtx = ctx;
        return { id: "u1" };
      },
    };

    const result = await authenticateMcpRequest(adapter, undefined, {
      origin: ORIGIN,
      authorization: "Bearer tok-123",
    });

    expect(result).toEqual({ ok: true, user: { id: "u1" } });
    expect(seenToken).toBe("tok-123");
    // The origin context is what lets adapters enforce aud binding (RFC 8707).
    expect(seenCtx).toEqual({ origin: ORIGIN });
  });

  test("disallowed browser Origin is rejected with 403 before touching the token", async () => {
    let called = false;
    const adapter: McpAuthAdapter = {
      mountRoutes: () => {},
      validateToken: async () => {
        called = true;
        return {};
      },
    };

    const result = await authenticateMcpRequest(adapter, ["https://trusted.example"], {
      origin: ORIGIN,
      originHeader: "https://evil.example",
      authorization: "Bearer tok",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.body.error).toBe("forbidden");
    }
    expect(called).toBe(false);
  });

  test("requests without an Origin header pass the allowlist (native clients)", async () => {
    const result = await authenticateMcpRequest(
      adapterReturning({ id: "u1" }),
      ["https://trusted.example"],
      { origin: ORIGIN, authorization: "Bearer tok" },
    );
    expect(result.ok).toBe(true);
  });

  test("missing Bearer token yields 401 with resource_metadata discovery header", async () => {
    const result = await authenticateMcpRequest(adapterReturning({}), undefined, {
      origin: ORIGIN,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.body.error).toBe("unauthorized");
      expect(result.headers["WWW-Authenticate"]).toBe(
        `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`,
      );
    }
  });

  test("a token the adapter rejects yields 401 invalid_token with the discovery header", async () => {
    const adapter: McpAuthAdapter = {
      mountRoutes: () => {},
      validateToken: async () => {
        throw new Error("bad audience");
      },
    };

    const result = await authenticateMcpRequest(adapter, undefined, {
      origin: ORIGIN,
      authorization: "Bearer stolen-token",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.body.error).toBe("invalid_token");
      expect(result.headers["WWW-Authenticate"]).toContain("resource_metadata");
    }
  });
});

describe("resolveAuthAdapter", () => {
  test("passes a custom adapter through untouched", () => {
    const adapter = adapterReturning({ id: "u1" });
    expect(resolveAuthAdapter(adapter)).toBe(adapter);
  });

  test("wraps built-in options into an adapter", () => {
    const resolved = resolveAuthAdapter({
      validateCredentials: async () => null,
      jwtSecret: "x".repeat(32),
    });
    expect(typeof resolved.validateToken).toBe("function");
    expect(typeof resolved.mountRoutes).toBe("function");
  });
});
