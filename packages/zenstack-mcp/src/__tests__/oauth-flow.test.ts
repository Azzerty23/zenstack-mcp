import { describe, expect, test } from "bun:test";
import { mountOAuthRoutes } from "../auth-adapters/oauth/oauth-server.js";
import { verifyToken } from "../auth-adapters/oauth/jwt.js";
import type { GenericRequest, GenericResponse, RouterAdapter } from "../types.js";
import { jsonData } from "./helpers.js";

const JWT_SECRET = "test-jwt-secret-at-least-32-chars!!";

type RouteHandler = (req: GenericRequest) => GenericResponse | Promise<GenericResponse>;

function createFullHarness() {
  const getHandlers = new Map<string, RouteHandler>();
  const postHandlers = new Map<string, RouteHandler>();

  const router: RouterAdapter = {
    get(path, handler) { getHandlers.set(path, handler); },
    post(path, handler) { postHandlers.set(path, handler); },
  };

  function makeReq(overrides: Omit<Partial<GenericRequest>, "body"> & { body?: Record<string, unknown> }): GenericRequest {
    const { body, ...rest } = overrides;
    return {
      origin: "https://server.example",
      query: {},
      body: async () => body ?? {},
      ...rest,
    };
  }

  return {
    router,
    async get(path: string, query: Record<string, string> = {}): Promise<GenericResponse> {
      const handler = getHandlers.get(path);
      if (!handler) throw new Error(`No GET handler for ${path}`);
      return handler(makeReq({ query }));
    },
    async post(path: string, body: Record<string, unknown> = {}): Promise<GenericResponse> {
      const handler = postHandlers.get(path);
      if (!handler) throw new Error(`No POST handler for ${path}`);
      return handler(makeReq({ body }));
    },
  };
}

// PKCE helpers
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

const TEST_USER = { id: "u1", email: "alice@example.com" };

function setupOAuthServer() {
  const harness = createFullHarness();
  mountOAuthRoutes(harness.router, {
    jwtSecret: JWT_SECRET,
    validateCredentials: async (email, password) => {
      if (email === TEST_USER.email && password === "secret") return TEST_USER;
      return null;
    },
  });
  return harness;
}

describe("built-in OAuth — full authorization_code flow", () => {
  test("register → authorize → login → token: issues a valid access token", async () => {
    const harness = setupOAuthServer();
    const { verifier, challenge } = await generatePkce();

    // 1. Register client
    const regRes = await harness.post("/register", {
      redirect_uris: ["https://client.example/callback"],
    });
    expect(regRes.status ?? 200).toBe(201);
    const regData = jsonData(regRes) as Record<string, unknown>;
    const clientId = regData.client_id as string;
    expect(typeof clientId).toBe("string");

    // 2. GET /oauth/authorize — should serve the login page (HTML)
    const authRes = await harness.get("/oauth/authorize", {
      client_id: clientId,
      redirect_uri: "https://client.example/callback",
      code_challenge: challenge,
      response_type: "code",
    });
    expect(authRes.type).toBe("html");

    // 3. POST /login — get authorization code
    const loginRes = await harness.post("/login", {
      email: TEST_USER.email,
      password: "secret",
      redirect_uri: "https://client.example/callback",
      code_challenge: challenge,
      client_id: clientId,
    });
    expect(loginRes.type).toBe("json");
    const { redirectUrl } = jsonData(loginRes) as { redirectUrl: string };
    const code = new URL(redirectUrl).searchParams.get("code");
    expect(typeof code).toBe("string");

    // 4. POST /oauth/token — exchange code for tokens
    const tokenRes = await harness.post("/oauth/token", {
      grant_type: "authorization_code",
      code: code!,
      code_verifier: verifier,
    });
    expect(tokenRes.type).toBe("json");
    const tokens = jsonData(tokenRes) as Record<string, unknown>;
    expect(typeof tokens.access_token).toBe("string");
    expect(typeof tokens.refresh_token).toBe("string");
    expect(tokens.token_type).toBe("bearer");

    // 5. Verify the JWT is valid and contains user data
    const payload = await verifyToken(tokens.access_token as string, JWT_SECRET);
    expect((payload as Record<string, unknown>).id).toBe(TEST_USER.id);
  });

  test("token endpoint rejects wrong code_verifier", async () => {
    const harness = setupOAuthServer();
    const { challenge } = await generatePkce();
    const { verifier: wrongVerifier } = await generatePkce(); // different pair

    const regRes = await harness.post("/register", {
      redirect_uris: ["https://client.example/callback"],
    });
    const clientId = (jsonData(regRes) as Record<string, unknown>).client_id as string;

    const loginRes = await harness.post("/login", {
      email: TEST_USER.email,
      password: "secret",
      redirect_uri: "https://client.example/callback",
      code_challenge: challenge,
      client_id: clientId,
    });
    const code = new URL((jsonData(loginRes) as { redirectUrl: string }).redirectUrl)
      .searchParams.get("code")!;

    const tokenRes = await harness.post("/oauth/token", {
      grant_type: "authorization_code",
      code,
      code_verifier: wrongVerifier,
    });
    expect(tokenRes.status).toBe(400);
    expect((jsonData(tokenRes) as Record<string, unknown>).error).toBe("invalid_grant");
  });

  test("authorization code is one-time use", async () => {
    const harness = setupOAuthServer();
    const { verifier, challenge } = await generatePkce();

    const regRes = await harness.post("/register", {
      redirect_uris: ["https://client.example/callback"],
    });
    const clientId = (jsonData(regRes) as Record<string, unknown>).client_id as string;

    const loginRes = await harness.post("/login", {
      email: TEST_USER.email,
      password: "secret",
      redirect_uri: "https://client.example/callback",
      code_challenge: challenge,
      client_id: clientId,
    });
    const code = new URL((jsonData(loginRes) as { redirectUrl: string }).redirectUrl)
      .searchParams.get("code")!;

    // First exchange succeeds
    const first = await harness.post("/oauth/token", {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
    });
    expect((jsonData(first) as Record<string, unknown>).access_token).toBeDefined();

    // Second exchange must fail (code already consumed)
    const second = await harness.post("/oauth/token", {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
    });
    expect(second.status).toBe(400);
    expect((jsonData(second) as Record<string, unknown>).error).toBe("invalid_grant");
  });

  test("refresh_token grant issues new tokens and preserves user", async () => {
    const harness = setupOAuthServer();
    const { verifier, challenge } = await generatePkce();

    const regRes = await harness.post("/register", {
      redirect_uris: ["https://client.example/callback"],
    });
    const clientId = (jsonData(regRes) as Record<string, unknown>).client_id as string;

    const loginRes = await harness.post("/login", {
      email: TEST_USER.email,
      password: "secret",
      redirect_uri: "https://client.example/callback",
      code_challenge: challenge,
      client_id: clientId,
    });
    const code = new URL((jsonData(loginRes) as { redirectUrl: string }).redirectUrl)
      .searchParams.get("code")!;

    const tokenRes = await harness.post("/oauth/token", {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
    });
    const { refresh_token } = jsonData(tokenRes) as Record<string, string>;

    // Use the refresh token
    const refreshRes = await harness.post("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token,
    });
    expect(refreshRes.type).toBe("json");
    const refreshed = jsonData(refreshRes) as Record<string, unknown>;
    expect(typeof refreshed.access_token).toBe("string");
    expect(typeof refreshed.refresh_token).toBe("string");

    // Verify the new access token is valid
    const payload = await verifyToken(refreshed.access_token as string, JWT_SECRET);
    expect((payload as Record<string, unknown>).id).toBe(TEST_USER.id);

    // The consumed refresh token must be invalid now (one-time use)
    const reuseRes = await harness.post("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token,
    });
    expect(reuseRes.status).toBe(400);
    expect((jsonData(reuseRes) as Record<string, unknown>).error).toBe("invalid_grant");
  });
});

describe("built-in OAuth — /login guard rails", () => {
  test("login rejects missing code_challenge", async () => {
    const harness = setupOAuthServer();
    const regRes = await harness.post("/register", {
      redirect_uris: ["https://client.example/callback"],
    });
    const clientId = (jsonData(regRes) as Record<string, unknown>).client_id as string;

    const res = await harness.post("/login", {
      email: TEST_USER.email,
      password: "secret",
      redirect_uri: "https://client.example/callback",
      // code_challenge intentionally omitted
      client_id: clientId,
    });
    expect(res.status).toBe(400);
    expect((jsonData(res) as Record<string, unknown>).error).toBe("invalid_request");
  });

  test("login rejects invalid credentials", async () => {
    const harness = setupOAuthServer();
    const { challenge } = await generatePkce();
    const regRes = await harness.post("/register", {
      redirect_uris: ["https://client.example/callback"],
    });
    const clientId = (jsonData(regRes) as Record<string, unknown>).client_id as string;

    const res = await harness.post("/login", {
      email: TEST_USER.email,
      password: "wrong",
      redirect_uri: "https://client.example/callback",
      code_challenge: challenge,
      client_id: clientId,
    });
    expect(res.status).toBe(401);
  });

  test("login rejects redirect_uri not in client allowlist", async () => {
    const harness = setupOAuthServer();
    const { challenge } = await generatePkce();
    const regRes = await harness.post("/register", {
      redirect_uris: ["https://client.example/callback"],
    });
    const clientId = (jsonData(regRes) as Record<string, unknown>).client_id as string;

    const res = await harness.post("/login", {
      email: TEST_USER.email,
      password: "secret",
      redirect_uri: "https://attacker.example/steal",
      code_challenge: challenge,
      client_id: clientId,
    });
    expect(res.status).toBe(400);
    expect((jsonData(res) as Record<string, unknown>).error).toBe("invalid_redirect_uri");
  });

  test("state parameter is forwarded to the redirect URL", async () => {
    const harness = setupOAuthServer();
    const { challenge } = await generatePkce();
    const regRes = await harness.post("/register", {
      redirect_uris: ["https://client.example/callback"],
    });
    const clientId = (jsonData(regRes) as Record<string, unknown>).client_id as string;

    const res = await harness.post("/login", {
      email: TEST_USER.email,
      password: "secret",
      redirect_uri: "https://client.example/callback",
      code_challenge: challenge,
      client_id: clientId,
      state: "csrf-token-xyz",
    });
    const url = new URL((jsonData(res) as { redirectUrl: string }).redirectUrl);
    expect(url.searchParams.get("state")).toBe("csrf-token-xyz");
  });
});
