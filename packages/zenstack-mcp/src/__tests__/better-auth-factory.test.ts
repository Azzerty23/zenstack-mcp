import { describe, expect, test } from "bun:test";
import { betterAuthMcpAdapter } from "../auth-adapters/better-auth/adapter.js";
import type {
  GenericRequest,
  GenericResponse,
  RouterAdapter,
} from "../types.js";
import { jsonData } from "./helpers.js";

const SECRET = "stateless-secret-at-least-32-chars!!";
const TEST_USER = { id: "u1", email: "alice@example.com" };
const REDIRECT = "https://client.example/callback";

type RouteHandler = (
  req: GenericRequest,
) => GenericResponse | Promise<GenericResponse>;

async function generatePkce() {
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return { verifier, challenge };
}

// Factory form: getAuth() yields a fresh instance per call (here it just counts
// calls). A real caller would build it with a request-scoped db.
function createFactoryHarness() {
  let getAuthCalls = 0;
  const postHandlers = new Map<string, RouteHandler>();
  const router: RouterAdapter = {
    get() {},
    post(path, handler) {
      postHandlers.set(path, handler);
    },
  };

  const adapter = betterAuthMcpAdapter({
    getAuth: () => {
      getAuthCalls++;
      return {
        options: { baseURL: "https://server.example", secret: SECRET },
        api: {
          getSession: async () => ({ user: TEST_USER }),
          signInEmail: async () => ({
            token: "session-token",
            user: TEST_USER,
          }),
        },
      };
    },
    baseURL: "https://server.example",
    secret: SECRET,
  });
  adapter.mountRoutes(router);

  return {
    adapter,
    getAuthCalls: () => getAuthCalls,
    async post(
      path: string,
      body: Record<string, unknown>,
    ): Promise<GenericResponse> {
      const handler = postHandlers.get(path);
      if (!handler) throw new Error(`No POST handler for ${path}`);
      return handler({ origin: "https://server.example", query: {}, body: async () => body });
    },
  };
}

describe("betterAuthMcpAdapter — factory form", () => {
  test("drives the full authorization_code flow and resolves auth per API call", async () => {
    const harness = createFactoryHarness();
    const { verifier, challenge } = await generatePkce();

    const reg = await harness.post("/register", { redirect_uris: [REDIRECT] });
    const clientId = (jsonData(reg) as Record<string, unknown>)
      .client_id as string;

    // No DB-touching API call yet → factory not invoked.
    expect(harness.getAuthCalls()).toBe(0);

    const login = await harness.post("/login", {
      email: TEST_USER.email,
      password: "secret",
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      client_id: clientId,
    });
    // signInEmail ran → factory invoked exactly once.
    expect(harness.getAuthCalls()).toBe(1);

    const code = new URL(
      (jsonData(login) as { redirectUrl: string }).redirectUrl,
    ).searchParams.get("code")!;

    const tokenRes = await harness.post("/oauth/token", {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
    });
    const accessToken = (jsonData(tokenRes) as Record<string, unknown>)
      .access_token as string;
    expect(typeof accessToken).toBe("string");

    // Stateless validateToken is pure crypto → must NOT call the factory.
    const callsBefore = harness.getAuthCalls();
    const user = await harness.adapter.validateToken(accessToken);
    expect(user).toEqual(TEST_USER);
    expect(harness.getAuthCalls()).toBe(callsBefore);
  });
});
