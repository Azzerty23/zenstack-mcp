import { describe, expect, test } from "bun:test";

import { betterAuthMcpAdapter } from "../auth-adapters/better-auth/adapter.js";
import { mountOAuthRoutes } from "../auth-adapters/oauth/oauth-server.js";
import type { GenericRequest, GenericResponse, RouterAdapter } from "../types.js";

type RouteHandler = (req: GenericRequest) => GenericResponse | Promise<GenericResponse>;
const VALID_TEST_SECRET_32_CHARS = "s".repeat(32);

function createRouterHarness() {
  const postHandlers = new Map<string, RouteHandler>();

  const router: RouterAdapter = {
    get() {},
    post(path, handler) {
      postHandlers.set(path, handler);
    },
  };

  return {
    router,
    async post(
      path: string,
      body: Record<string, unknown>,
      overrides: Partial<GenericRequest> = {},
    ) {
      const handler = postHandlers.get(path);
      if (!handler) throw new Error(`Missing POST handler for ${path}`);
      return handler({
        origin: "https://server.example",
        query: {},
        body: async () => body,
        ...overrides,
      });
    },
  };
}

describe("OAuth redirect URI validation", () => {
  test("built-in auth rejects javascript redirect URIs at registration time", async () => {
    const { router, post } = createRouterHarness();
    mountOAuthRoutes(router, {
      jwtSecret: "x".repeat(32),
      validateCredentials: async () => null,
    });

    const response = await post("/register", {
      redirect_uris: ["javascript:alert('owned')"],
    });

    expect(response).toMatchObject({
      type: "json",
      status: 400,
      data: { error: "invalid_redirect_uri" },
    });
  });

  test("built-in auth rejects registrations without redirect URIs", async () => {
    const { router, post } = createRouterHarness();
    mountOAuthRoutes(router, {
      jwtSecret: "x".repeat(32),
      validateCredentials: async () => null,
    });

    const response = await post("/register", {});

    expect(response).toMatchObject({
      type: "json",
      status: 400,
      data: { error: "invalid_redirect_uri" },
    });
  });

  test("built-in auth still accepts loopback HTTP redirect URIs", async () => {
    const { router, post } = createRouterHarness();
    mountOAuthRoutes(router, {
      jwtSecret: "x".repeat(32),
      validateCredentials: async () => null,
    });

    const response = await post("/register", {
      redirect_uris: ["http://127.0.0.1:8787/callback"],
    });

    expect(response).toMatchObject({
      type: "json",
      status: 201,
      data: { redirect_uris: ["http://127.0.0.1:8787/callback"] },
    });
  });

  test("better-auth rejects javascript redirect URIs at registration time", async () => {
    const { router, post } = createRouterHarness();
    const adapter = betterAuthMcpAdapter(
      {
        options: {
          baseURL: "https://server.example",
          secret: VALID_TEST_SECRET_32_CHARS,
        },
        api: {
          getSession: async () => null,
          signInEmail: async () => ({ token: "session-token", user: { id: "u1" } }),
        },
      },
      { secret: VALID_TEST_SECRET_32_CHARS },
    );
    adapter.mountRoutes(router);

    const response = await post("/register", {
      redirect_uris: ["javascript:alert('owned')"],
    });

    expect(response).toMatchObject({
      type: "json",
      status: 400,
      data: { error: "invalid_redirect_uri" },
    });
  });
});

describe("betterAuthMcpAdapter secret validation", () => {
  test("rejects insecure stateless secrets", () => {
    expect(() =>
      betterAuthMcpAdapter({
        options: {
          baseURL: "https://server.example",
          secret: "too-short",
        },
        api: {
          getSession: async () => null,
          signInEmail: async () => ({ token: "session-token", user: { id: "u1" } }),
        },
      }),
    ).toThrow(/at least 32 characters/i);
  });

  test("stateful mode does not require a signing secret", () => {
    expect(() =>
      betterAuthMcpAdapter(
        {
          options: {
            baseURL: "https://server.example",
            secret: "too-short",
          },
          api: {
            getSession: async () => null,
            signInEmail: async () => ({ token: "session-token", user: { id: "u1" } }),
          },
        },
        { stateful: true },
      ),
    ).not.toThrow();
  });
});
