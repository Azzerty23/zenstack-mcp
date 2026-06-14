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

describe("OAuth client registry limits", () => {
  const REDIRECT = ["https://app.example/callback"];

  test("enforces maxClients cap with 429", async () => {
    const { router, post } = createRouterHarness();
    mountOAuthRoutes(router, {
      jwtSecret: "x".repeat(32),
      validateCredentials: async () => null,
      maxClients: 2,
    });

    expect(await post("/register", { redirect_uris: REDIRECT })).toMatchObject({ status: 201 });
    expect(await post("/register", { redirect_uris: REDIRECT })).toMatchObject({ status: 201 });
    expect(await post("/register", { redirect_uris: REDIRECT })).toMatchObject({
      status: 429,
      data: { error: "too_many_clients" },
    });
  });

  test("initialAccessToken gates registration before the cap", async () => {
    const { router, post } = createRouterHarness();
    mountOAuthRoutes(router, {
      jwtSecret: "x".repeat(32),
      validateCredentials: async () => null,
      initialAccessToken: "secret-iat",
    });

    expect(await post("/register", { redirect_uris: REDIRECT })).toMatchObject({
      status: 401,
      data: { error: "invalid_token" },
    });
    expect(
      await post(
        "/register",
        { redirect_uris: REDIRECT },
        { authorization: "Bearer secret-iat" },
      ),
    ).toMatchObject({ status: 201 });
  });

  test("expired clients are evicted, freeing registry slots", async () => {
    const { router, post } = createRouterHarness();
    mountOAuthRoutes(router, {
      jwtSecret: "x".repeat(32),
      validateCredentials: async () => null,
      maxClients: 1,
      clientTtl: 0, // every client expires immediately
    });

    expect(await post("/register", { redirect_uris: REDIRECT })).toMatchObject({ status: 201 });
    // Let wall-clock advance past the (zero) TTL so purge evicts the first client.
    await new Promise((r) => setTimeout(r, 10));
    // Without eviction this would be 429; the purge frees the slot.
    expect(await post("/register", { redirect_uris: REDIRECT })).toMatchObject({ status: 201 });
  });

  test("/login rejects an unknown client_id with invalid_client", async () => {
    const { router, post } = createRouterHarness();
    mountOAuthRoutes(router, {
      jwtSecret: "x".repeat(32),
      validateCredentials: async () => ({ id: "u1" }),
    });

    const response = await post("/login", {
      email: "a@b.c",
      password: "pw",
      redirect_uri: REDIRECT[0],
      code_challenge: "challenge",
      client_id: "never-registered",
    });

    expect(response).toMatchObject({
      status: 400,
      data: { error: "invalid_client" },
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
