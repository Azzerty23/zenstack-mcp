/**
 * End-to-end coverage of RFC 8707 resource binding: access tokens are minted
 * with an `aud` claim naming this server and rejected anywhere else, and token
 * requests naming a foreign `resource` are refused with `invalid_target`.
 */
import { describe, expect, test } from "bun:test";

import { builtInMcpAuth } from "../auth-adapters/oauth/index.js";
import { betterAuthMcpAdapter } from "../auth-adapters/better-auth/adapter.js";
import type {
  GenericRequest,
  GenericResponse,
  McpAuthAdapter,
  RouterAdapter,
} from "../types.js";
import { jsonData } from "./helpers.js";

const JWT_SECRET = "test-jwt-secret-at-least-32-chars!!";
const ORIGIN = "https://server.example";
const REDIRECT = "https://client.example/callback";
const TEST_USER = { id: "u1", email: "alice@example.com" };

type RouteHandler = (req: GenericRequest) => GenericResponse | Promise<GenericResponse>;

function createHarness(adapter: McpAuthAdapter) {
  const getHandlers = new Map<string, RouteHandler>();
  const postHandlers = new Map<string, RouteHandler>();
  const router: RouterAdapter = {
    get(path, handler) { getHandlers.set(path, handler); },
    post(path, handler) { postHandlers.set(path, handler); },
  };
  adapter.mountRoutes(router);

  const makeReq = (query: Record<string, string>, body: Record<string, unknown>): GenericRequest => ({
    origin: ORIGIN,
    query,
    body: async () => body,
  });

  return {
    adapter,
    async get(path: string, query: Record<string, string> = {}) {
      const handler = getHandlers.get(path);
      if (!handler) throw new Error(`No GET handler for ${path}`);
      return handler(makeReq(query, {}));
    },
    async post(path: string, body: Record<string, unknown> = {}) {
      const handler = postHandlers.get(path);
      if (!handler) throw new Error(`No POST handler for ${path}`);
      return handler(makeReq({}, body));
    },
  };
}

async function generatePkce() {
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return { verifier, challenge };
}

/** register → login → token; returns the access token plus a token-request replayer. */
async function obtainAccessToken(
  harness: ReturnType<typeof createHarness>,
  tokenExtras: Record<string, unknown> = {},
) {
  const { verifier, challenge } = await generatePkce();
  const reg = await harness.post("/register", { redirect_uris: [REDIRECT] });
  const clientId = (jsonData(reg) as Record<string, unknown>).client_id as string;

  const login = await harness.post("/login", {
    email: TEST_USER.email,
    password: "secret",
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    client_id: clientId,
  });
  const code = new URL((jsonData(login) as { redirectUrl: string }).redirectUrl)
    .searchParams.get("code")!;

  const tokenRes = await harness.post("/oauth/token", {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    ...tokenExtras,
  });
  return tokenRes;
}

function builtInHarness(resource?: string) {
  return createHarness(
    builtInMcpAuth({
      jwtSecret: JWT_SECRET,
      resource,
      validateCredentials: async (email, password) =>
        email === TEST_USER.email && password === "secret" ? TEST_USER : null,
    }),
  );
}

describe("built-in OAuth — audience binding", () => {
  test("issued tokens validate against the issuing origin and nothing else", async () => {
    const harness = builtInHarness();
    const tokens = jsonData(await obtainAccessToken(harness)) as { access_token: string; refresh_token: string };

    const user = await harness.adapter.validateToken(tokens.access_token, { origin: ORIGIN });
    expect((user as Record<string, unknown>).id).toBe(TEST_USER.id);

    await expect(
      harness.adapter.validateToken(tokens.access_token, { origin: "https://other.example" }),
    ).rejects.toThrow();
  });

  test("refreshed tokens carry the audience too", async () => {
    const harness = builtInHarness();
    const tokens = jsonData(await obtainAccessToken(harness)) as { access_token: string; refresh_token: string };

    const refreshRes = await harness.post("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    });
    const refreshed = jsonData(refreshRes) as { access_token: string; refresh_token: string };

    const user = await harness.adapter.validateToken(refreshed.access_token, { origin: ORIGIN });
    expect((user as Record<string, unknown>).id).toBe(TEST_USER.id);
    await expect(
      harness.adapter.validateToken(refreshed.access_token, { origin: "https://other.example" }),
    ).rejects.toThrow();
  });

  test("token request naming a foreign resource is rejected with invalid_target", async () => {
    const harness = builtInHarness();
    const res = await obtainAccessToken(harness, { resource: "https://evil.example" });
    expect(res.status).toBe(400);
    expect((jsonData(res) as Record<string, unknown>).error).toBe("invalid_target");
  });

  test("token request naming the server itself (origin or sub-path) is accepted", async () => {
    const sameOrigin = jsonData(await obtainAccessToken(builtInHarness(), { resource: ORIGIN }));
    expect(typeof sameOrigin.access_token).toBe("string");
    // Clients commonly send the full MCP endpoint URL rather than the bare origin.
    const subPath = jsonData(await obtainAccessToken(builtInHarness(), { resource: `${ORIGIN}/mcp` }));
    expect(typeof subPath.access_token).toBe("string");
  });

  test("authorize request naming a foreign resource is rejected with invalid_target", async () => {
    const harness = builtInHarness();
    const reg = await harness.post("/register", { redirect_uris: [REDIRECT] });
    const clientId = (jsonData(reg) as Record<string, unknown>).client_id as string;

    const res = await harness.get("/oauth/authorize", {
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: "challenge",
      resource: "https://evil.example",
    });
    expect(res.status).toBe(400);
    expect((jsonData(res) as Record<string, unknown>).error).toBe("invalid_target");
  });

  test("an explicit `resource` option pins the audience regardless of request origin", async () => {
    const harness = builtInHarness("https://canonical.example");
    const tokens = jsonData(await obtainAccessToken(harness)) as { access_token: string; refresh_token: string };

    // ctx.origin differs from the canonical resource — the configured value wins.
    const user = await harness.adapter.validateToken(tokens.access_token, { origin: ORIGIN });
    expect((user as Record<string, unknown>).id).toBe(TEST_USER.id);
  });

  test("protected-resource metadata advertises the configured resource", async () => {
    const harness = builtInHarness("https://canonical.example");
    const meta = jsonData(await harness.get("/.well-known/oauth-protected-resource"));
    expect(meta.resource).toBe("https://canonical.example");
  });
});

describe("better-auth (stateless) — audience binding", () => {
  const SECRET = "stateless-secret-at-least-32-chars!!";

  function betterAuthHarness(baseURL: string) {
    return createHarness(
      betterAuthMcpAdapter({
        options: { baseURL, secret: SECRET },
        api: {
          getSession: async () => ({ user: TEST_USER }),
          signInEmail: async () => ({ token: "session-token", user: TEST_USER }),
        },
      }),
    );
  }

  test("a token minted by a server with another baseURL and the same secret is rejected", async () => {
    const harnessA = betterAuthHarness("https://a.example");
    const harnessB = betterAuthHarness("https://b.example");

    const tokens = jsonData(await obtainAccessToken(harnessA)) as { access_token: string; refresh_token: string };

    // Accepted where it was minted…
    const user = await harnessA.adapter.validateToken(tokens.access_token);
    expect((user as Record<string, unknown>).id).toBe(TEST_USER.id);
    // …rejected by the sibling server sharing the secret.
    await expect(harnessB.adapter.validateToken(tokens.access_token)).rejects.toThrow();
  });

  test("token request naming a foreign resource is rejected with invalid_target", async () => {
    const harness = betterAuthHarness(ORIGIN);
    const res = await obtainAccessToken(harness, { resource: "https://evil.example" });
    expect(res.status).toBe(400);
    expect((jsonData(res) as Record<string, unknown>).error).toBe("invalid_target");
  });

  test("refresh grant naming a foreign resource is rejected with invalid_target", async () => {
    const harness = betterAuthHarness(ORIGIN);
    const tokens = jsonData(await obtainAccessToken(harness)) as { access_token: string; refresh_token: string };

    const res = await harness.post("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      resource: "https://evil.example",
    });
    expect(res.status).toBe(400);
    expect((jsonData(res) as Record<string, unknown>).error).toBe("invalid_target");
  });
});
