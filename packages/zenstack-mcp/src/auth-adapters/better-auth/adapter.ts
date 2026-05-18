import type { McpAuthAdapter, RouterAdapter } from "../../types.js";
import { injectLoginScript, loginPage } from "../login-page.js";
import {
  createInMemoryTokenStore,
  pkceVerify,
  randomCode,
} from "../oauth/store.js";
import { normalizeRedirectUris } from "../oauth/redirect-uri.js";
import {
  decryptCode,
  encryptCode,
  signAccessToken,
  verifyAccessToken,
  signClientId,
  verifyClientId,
  signRefreshToken,
  verifyRefreshToken,
} from "./stateless.js";

/**
 * Creates an MCP auth adapter for a better-auth instance.
 *
 * Supports two modes based on whether a secret is available:
 *
 * **Stateless (default)** — the secret is read from `auth.options.secret` automatically.
 * client_ids and auth codes are self-contained cryptographic tokens — no shared state
 * is needed between requests. Suitable for multi-instance or serverless deployments
 * (Cloudflare Workers, Lambda, etc.). Trade-off: revoked sessions remain valid until
 * the token expires.
 *
 * **Stateful** — opt in with `{ stateful: true }`. client_ids are opaque UUIDs stored
 * in a per-instance Map. Session validation calls `auth.api.getSession()` on every
 * request, so revocations take effect immediately. Only suitable for single-instance
 * deployments.
 *
 * ```ts
 * import { betterAuthMcpAdapter } from 'zenstack-mcp/auth-adapters/better-auth'
 * import { auth } from '~/lib/auth'
 *
 * const { oauthRoutes, mcpMiddleware } = createHonoMcpHandler({
 *   // secret read from auth.options.secret automatically → stateless (default)
 *   auth: betterAuthMcpAdapter(auth),
 *   // or, to force stateful mode:
 *   auth: betterAuthMcpAdapter(auth, { stateful: true }),
 * })
 * ```
 */
export function betterAuthMcpAdapter(
  auth: {
    options: {
      baseURL: string;
      /** Native better-auth secret. Used as the signing secret for stateless mode when no explicit `secret` option is provided. */
      secret?: string;
      /** Read to align the MCP token TTL with the actual better-auth session TTL */
      session?: { expiresIn?: number };
    };
    api: {
      getSession(opts: { headers: Headers }): Promise<{ user: unknown } | null>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      signInEmail(opts: {
        body: { email: string; password: string };
      }): Promise<any>;
    };
  },
  options?: {
    /** Override the default login page. Accepts an HTML string or an async function returning one. */
    loginPage?: string | (() => string | Promise<string>);
    /** Maximum number of OAuth clients that can be registered (default: 100). Stateful only. */
    maxClients?: number;
    /** Pre-shared bearer token required on `POST /register`. When omitted, registration is open. */
    initialAccessToken?: string;
    /**
     * Force stateful mode.
     *
     * In stateful mode client_ids are opaque UUIDs stored in a per-instance Map and
     * every token validation calls `auth.api.getSession()`, so revocations take effect
     * immediately. Only suitable for single-instance deployments.
     */
    stateful?: boolean;
    /**
     * Signing secret for stateless mode. Defaults to `auth.options.secret`.
     *
     * Override only if you need a different secret than the one used by better-auth.
     */
    secret?: string;
    /**
     * Refresh token lifetime in seconds. Only used in stateless mode (`secret` provided).
     *
     * On refresh, the better-auth session is validated via `auth.api.getSession()` (one DB call),
     * so revocations take effect at refresh time. Defaults to 30 days.
     */
    refreshTokenExpiresIn?: number;
  },
): McpAuthAdapter {
  const base = auth.options.baseURL;
  const expiresIn = auth.options.session?.expiresIn ?? 3600;
  const secret = options?.stateful
    ? undefined
    : (options?.secret ?? auth.options.secret);
  if (secret && secret.length < 32) {
    throw new Error(
      "zenstack-mcp: better-auth stateless secret must be at least 32 characters",
    );
  }
  const refreshTokenExpiresIn =
    options?.refreshTokenExpiresIn ?? 30 * 24 * 3600;

  return {
    mountRoutes(router: RouterAdapter) {
      // ── Client registration strategy ──────────────────────────────────────
      //
      // Stateful:  opaque UUID stored in a per-instance Map → redirect_uris.
      //            Enforces maxClients cap; revocation is instant.
      //
      // Stateless: redirect_uris embedded in an HMAC-signed client_id.
      //            No storage needed — safe across multiple instances.
      const clientRegistry = secret ? null : new Map<string, string[]>();
      const maxClients = options?.maxClients ?? 100;

      async function registerClient(
        redirectUris: string[],
      ): Promise<string | null> {
        if (secret) return signClientId(redirectUris, secret);
        if (clientRegistry!.size >= maxClients) return null;
        const clientId = crypto.randomUUID();
        clientRegistry!.set(clientId, redirectUris);
        return clientId;
      }

      async function resolveAllowedUris(
        clientId: string,
      ): Promise<string[] | null> {
        if (secret) return verifyClientId(clientId, secret);
        return clientRegistry!.get(clientId) ?? null;
      }

      // ── PKCE authorization code strategy ─────────────────────────────────
      //
      // Stateful:  random opaque code stored in a per-instance Map.
      //            validateToken calls auth.api.getSession() — immediate revocation.
      //
      // Stateless: user + codeChallenge encrypted inside the code itself (AES-GCM).
      //            validateToken does a crypto verify — no DB round-trip.
      const codeStore = secret ? null : createInMemoryTokenStore();

      async function issueCode(
        userPayload: unknown,
        sessionToken: string,
        codeChallenge: string,
      ): Promise<string> {
        if (secret) {
          const accessToken = await signAccessToken(
            { user: userPayload, exp: Date.now() + expiresIn * 1000 },
            secret,
          );
          const refreshToken = await signRefreshToken(
            { sessionToken, exp: Date.now() + refreshTokenExpiresIn * 1000 },
            secret,
          );
          return encryptCode(
            {
              user: accessToken,
              refreshToken,
              codeChallenge,
              expiresAt: Date.now() + 5 * 60 * 1000,
            },
            secret,
          );
        }
        const code = randomCode();
        await codeStore!.saveCode(
          code,
          sessionToken,
          codeChallenge,
          Date.now() + 5 * 60 * 1000,
        );
        return code;
      }

      async function redeemCode(code: string): Promise<{
        user: unknown;
        refreshToken?: string;
        codeChallenge: string;
      } | null> {
        if (secret) return decryptCode(code, secret);
        return codeStore!.takeCode(code);
      }

      // ── Routes ────────────────────────────────────────────────────────────

      router.get("/.well-known/oauth-authorization-server", () => ({
        type: "json",
        data: {
          issuer: base,
          authorization_endpoint: `${base}/oauth/authorize`,
          token_endpoint: `${base}/oauth/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          grant_types_supported: secret
            ? ["authorization_code", "refresh_token"]
            : ["authorization_code"],
        },
      }));

      router.get("/.well-known/oauth-protected-resource", () => ({
        type: "json",
        data: {
          resource: base,
          authorization_servers: [base],
          bearer_methods_supported: ["header"],
        },
      }));

      router.post("/register", async (req) => {
        if (options?.initialAccessToken) {
          if (req.authorization !== `Bearer ${options.initialAccessToken}`)
            return {
              type: "json",
              status: 401,
              data: { error: "invalid_token" },
            };
        }
        const body = (await req.body()) as { redirect_uris?: unknown };
        const redirectUris = normalizeRedirectUris(body.redirect_uris);
        if (!redirectUris)
          return {
            type: "json",
            status: 400,
            data: { error: "invalid_redirect_uri" },
          };

        const clientId = await registerClient(redirectUris);
        if (!clientId)
          return {
            type: "json",
            status: 429,
            data: { error: "too_many_clients" },
          };

        return {
          type: "json",
          status: 201,
          data: {
            client_id: clientId,
            client_id_issued_at: Math.floor(Date.now() / 1000),
            redirect_uris: redirectUris,
            grant_types: ["authorization_code"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
          },
        };
      });

      router.get("/oauth/authorize", async (req) => {
        const {
          redirect_uri,
          code_challenge,
          client_id,
          code_challenge_method,
          response_type,
        } = req.query;
        if (!redirect_uri || !code_challenge || !client_id)
          return {
            type: "json",
            status: 400,
            data: { error: "invalid_request" },
          };
        if (response_type && response_type !== "code")
          return {
            type: "json",
            status: 400,
            data: { error: "unsupported_response_type" },
          };
        if (code_challenge_method && code_challenge_method !== "S256")
          return {
            type: "json",
            status: 400,
            data: {
              error: "invalid_request",
              error_description: "Only S256 code_challenge_method is supported",
            },
          };
        const allowedUris = await resolveAllowedUris(client_id);
        if (!allowedUris)
          return {
            type: "json",
            status: 400,
            data: { error: "invalid_client" },
          };
        if (!allowedUris.includes(redirect_uri))
          return {
            type: "json",
            status: 400,
            data: { error: "invalid_redirect_uri" },
          };
        try {
          const customPage = options?.loginPage;
          const html = customPage
            ? await (typeof customPage === "function"
                ? customPage()
                : customPage)
            : loginPage();
          return { type: "html", html: injectLoginScript(html) };
        } catch {
          return {
            type: "json",
            status: 500,
            data: {
              error: "server_error",
              error_description: "Failed to render login page",
            },
          };
        }
      });

      router.post("/login", async (req) => {
        const {
          email,
          password,
          redirect_uri,
          code_challenge,
          state,
          client_id,
        } = (await req.body()) as Record<string, string>;

        if (!email || !password || !redirect_uri || !code_challenge)
          return {
            type: "json",
            status: 400,
            data: { error: "invalid_request" },
          };

        // Validate redirect_uri again — the form could POST directly with an arbitrary
        // redirect_uri, bypassing the /oauth/authorize allowlist check.
        const allowedUris = client_id
          ? await resolveAllowedUris(client_id)
          : null;
        if (!allowedUris || !allowedUris.includes(redirect_uri))
          return {
            type: "json",
            status: 400,
            data: { error: "invalid_redirect_uri" },
          };

        let sessionToken: string | undefined;
        let userPayload: unknown;
        try {
          const result = await auth.api.signInEmail({
            body: { email, password },
          });
          sessionToken = result?.token;
          userPayload = result?.user;
        } catch {
          // authentication failed — fall through to error response
        }
        if (!sessionToken)
          return {
            type: "json",
            status: 401,
            data: { error: "Invalid credentials" },
          };

        const code = await issueCode(userPayload, sessionToken, code_challenge);
        const redirectUrl = new URL(redirect_uri);
        redirectUrl.searchParams.set("code", code);
        if (state) redirectUrl.searchParams.set("state", state);
        return { type: "json", data: { redirectUrl: redirectUrl.toString() } };
      });

      router.post("/oauth/token", async (req) => {
        const body = (await req.body()) as Record<string, string>;
        const { grant_type } = body;

        if (grant_type === "refresh_token") {
          if (!secret)
            return {
              type: "json",
              status: 400,
              data: { error: "unsupported_grant_type" },
            };
          const { refresh_token } = body;
          if (!refresh_token)
            return {
              type: "json",
              status: 400,
              data: { error: "invalid_request" },
            };
          const rtPayload = await verifyRefreshToken(refresh_token, secret);
          if (!rtPayload)
            return {
              type: "json",
              status: 400,
              data: { error: "invalid_grant" },
            };
          // One DB call — validates the session is still alive and gets fresh user data.
          const session = await auth.api.getSession({
            headers: new Headers({
              authorization: `Bearer ${rtPayload.sessionToken}`,
            }),
          });
          if (!session)
            return {
              type: "json",
              status: 400,
              data: { error: "invalid_grant" },
            };
          const accessToken = await signAccessToken(
            { user: session.user, exp: Date.now() + expiresIn * 1000 },
            secret,
          );
          const newRefreshToken = await signRefreshToken(
            { sessionToken: rtPayload.sessionToken, exp: rtPayload.exp },
            secret,
          );
          return {
            type: "json",
            data: {
              access_token: accessToken,
              refresh_token: newRefreshToken,
              token_type: "bearer",
              expires_in: expiresIn,
            },
          };
        }

        if (grant_type !== "authorization_code")
          return {
            type: "json",
            status: 400,
            data: { error: "unsupported_grant_type" },
          };
        const { code, code_verifier } = body;
        if (!code || !code_verifier)
          return {
            type: "json",
            status: 400,
            data: { error: "invalid_request" },
          };

        const entry = await redeemCode(code);
        if (!entry)
          return {
            type: "json",
            status: 400,
            data: { error: "invalid_grant" },
          };
        if (!(await pkceVerify(code_verifier, entry.codeChallenge)))
          return {
            type: "json",
            status: 400,
            data: { error: "invalid_grant" },
          };

        const tokenResponse: Record<string, unknown> = {
          access_token: entry.user,
          token_type: "bearer",
          expires_in: expiresIn,
        };
        if (entry.refreshToken) {
          tokenResponse.refresh_token = entry.refreshToken;
          tokenResponse.refresh_token_expires_in = refreshTokenExpiresIn;
        }
        return { type: "json", data: tokenResponse };
      });
    },

    validateToken: async (token: string) => {
      if (secret) {
        // Stateless: verify HMAC signature and extract embedded user — no DB round-trip.
        const payload = await verifyAccessToken(token, secret);
        if (!payload) throw new Error("Invalid or expired token");
        return payload.user;
      }
      // Stateful: session lookup via better-auth catches immediate revocations.
      const session = await auth.api.getSession({
        headers: new Headers({ authorization: `Bearer ${token}` }),
      });
      if (!session) throw new Error("Invalid or expired token");
      return session.user;
    },
  };
}
