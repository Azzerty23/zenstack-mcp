import { describe, expect, test } from "bun:test";
import { betterAuthMcpAdapter } from "../auth-adapters/better-auth/adapter.js";
import type { GenericRequest, GenericResponse, RouterAdapter } from "../types.js";
import { jsonData } from "./helpers.js";

const SECRET = "stateless-secret-at-least-32-chars!!";
const TEST_USER = { id: "u1", email: "alice@example.com" };
const REDIRECT = "https://client.example/callback";

type RouteHandler = (req: GenericRequest) => GenericResponse | Promise<GenericResponse>;

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

function createHarness(reuse?: {
  isConsumed(jti: string): Promise<boolean>;
  consume(jti: string, expiresAtMs: number): Promise<void>;
}) {
  const postHandlers = new Map<string, RouteHandler>();
  const router: RouterAdapter = {
    get() {},
    post(path, handler) {
      postHandlers.set(path, handler);
    },
  };

  betterAuthMcpAdapter(
    {
      options: { baseURL: "https://server.example", secret: SECRET },
      api: {
        getSession: async () => ({ user: TEST_USER }),
        signInEmail: async () => ({ token: "session-token", user: TEST_USER }),
      },
    },
    { secret: SECRET, refreshTokenReuse: reuse },
  ).mountRoutes(router);

  return {
    async post(path: string, body: Record<string, unknown>): Promise<GenericResponse> {
      const handler = postHandlers.get(path);
      if (!handler) throw new Error(`No POST handler for ${path}`);
      return handler({
        origin: "https://server.example",
        query: {},
        body: async () => body,
      });
    },
  };
}

// Drives register → login → token to obtain a first refresh_token.
async function obtainRefreshToken(harness: ReturnType<typeof createHarness>) {
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

  const token = await harness.post("/oauth/token", {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
  });
  return (jsonData(token) as Record<string, string>).refresh_token;
}

describe("better-auth stateless refresh token reuse detection", () => {
  test("without a reuse store, a refresh token can be replayed (documented trade-off)", async () => {
    const harness = createHarness();
    const refreshToken = await obtainRefreshToken(harness);

    const first = await harness.post("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    const second = await harness.post("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });

    expect((jsonData(first) as Record<string, unknown>).access_token).toBeDefined();
    // Replayable: same token still works a second time.
    expect((jsonData(second) as Record<string, unknown>).access_token).toBeDefined();
  });

  test("with a reuse store, replaying a consumed refresh token is rejected", async () => {
    const consumed = new Set<string>();
    const harness = createHarness({
      isConsumed: async (jti) => consumed.has(jti),
      consume: async (jti) => {
        consumed.add(jti);
      },
    });

    const refreshToken = await obtainRefreshToken(harness);

    const first = await harness.post("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    expect((jsonData(first) as Record<string, unknown>).access_token).toBeDefined();

    // Replaying the same (now consumed) refresh token must fail.
    const replay = await harness.post("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    expect(replay.status).toBe(400);
    expect((jsonData(replay) as Record<string, unknown>).error).toBe("invalid_grant");
  });

  test("the rotated refresh token has a fresh id and still works once", async () => {
    const consumed = new Set<string>();
    const harness = createHarness({
      isConsumed: async (jti) => consumed.has(jti),
      consume: async (jti) => {
        consumed.add(jti);
      },
    });

    const refreshToken = await obtainRefreshToken(harness);
    const first = await harness.post("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    const rotated = (jsonData(first) as Record<string, string>).refresh_token;

    // The new token is distinct and not yet consumed, so it works.
    expect(rotated).not.toBe(refreshToken);
    const second = await harness.post("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: rotated,
    });
    expect((jsonData(second) as Record<string, unknown>).access_token).toBeDefined();
  });
});
