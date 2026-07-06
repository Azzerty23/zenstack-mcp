import type { McpAuthAdapter, RouterAdapter } from "../../types.js";
import { loginPage } from "../login-page.js";
import {
  createInMemoryTokenStore,
  pkceVerify,
  randomCode,
  randomToken,
} from "../oauth/store.js";
import {
  checkResource,
  createAuthorizeHandler,
  createLoginHandler,
  createRegisterHandler,
  mountDiscoveryRoutes,
  oauthError,
} from "../shared.js";
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

/** The subset of a better-auth instance this adapter relies on. */
export type BetterAuthInstance = {
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
};

/**
 * Per-request form of the better-auth source.
 *
 * Instead of capturing a single long-lived instance, `getAuth` is invoked to obtain a
 * fresh instance **only when a better-auth API call is actually needed** — i.e. on
 * login (`signInEmail`) and on refresh / stateful validation (`getSession`). It is
 * never called on the stateless `validateToken` hot path (pure crypto).
 *
 * This lets serverless callers (Cloudflare Workers, Lambda) build the instance with a
 * **request-scoped** database client, so no DB connection outlives the request that
 * opened it — avoiding the long-lived-singleton + `maxUses: 1` workaround that a single
 * captured instance forces on workerd.
 *
 * The static OAuth config (`baseURL`, `secret`, session TTL) does not depend on the
 * request, so it is provided here directly rather than read from a resolved instance.
 */
export type BetterAuthFactory = {
  /** Returns a better-auth instance per call. Back it with a request-scoped db. */
  getAuth: () => BetterAuthInstance | Promise<BetterAuthInstance>;
  /** OAuth issuer / endpoint base — equivalent to `auth.options.baseURL`. */
  baseURL: string;
  /** Stateless signing secret — equivalent to `auth.options.secret`. */
  secret?: string;
  /** better-auth session TTL in seconds, to align the MCP token TTL (default 3600). */
  sessionExpiresIn?: number;
};

function isFactory(
  source: BetterAuthInstance | BetterAuthFactory,
): source is BetterAuthFactory {
  return typeof (source as BetterAuthFactory).getAuth === "function";
}

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
 * The first argument is either a captured better-auth instance, or a {@link BetterAuthFactory}
 * (`{ getAuth, baseURL, secret }`) that yields a fresh, request-scoped instance per API call —
 * preferred on serverless runtimes so the auth instance never holds a long-lived db connection.
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
 *   // or, per-request (serverless — request-scoped db, no long-lived connection):
 *   auth: betterAuthMcpAdapter({
 *     getAuth: () => createAuth(createDb()),
 *     baseURL: process.env.BETTER_AUTH_URL!,
 *     secret: process.env.BETTER_AUTH_SECRET!,
 *   }),
 * })
 * ```
 */
export function betterAuthMcpAdapter(
  auth: BetterAuthInstance | BetterAuthFactory,
  options?: {
    /** Override the default login page. Accepts an HTML string or an async function returning one. */
    loginPage?: string | (() => string | Promise<string>);
    /** Maximum number of OAuth clients that can be registered (default: 100). Stateful only. */
    maxClients?: number;
    /** Pre-shared bearer token required on `POST /register`. When omitted, registration is open. */
    initialAccessToken?: string;
    /**
     * Canonical resource URI of this MCP server (RFC 8707 resource indicator).
     * Defaults to the better-auth `baseURL`. Stateless access tokens are minted
     * with this value as their `aud` claim and rejected when presented to a
     * server with a different resource; token requests naming a different
     * `resource` are rejected with `invalid_target`.
     */
    resource?: string;
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
    /**
     * Optional store that turns stateless refresh tokens into one-time-use tokens
     * (rotation with reuse detection). Stateless refresh tokens are otherwise
     * replayable until they expire — a leaked token works repeatedly for the full
     * `refreshTokenExpiresIn` window.
     *
     * When provided, each refresh exchange records the consumed token id and rejects
     * any token whose id was already consumed (the hallmark of a stolen-token replay).
     * Back it with Redis or a database for multi-instance deployments; expire entries
     * at the `expiresAtMs` passed to `consume`.
     */
    refreshTokenReuse?: {
      /** Returns true if this token id was already consumed (→ reject as reuse). */
      isConsumed(jti: string): Promise<boolean>;
      /** Record a token id as consumed. `expiresAtMs` is when it may be forgotten. */
      consume(jti: string, expiresAtMs: number): Promise<void>;
    };
  },
): McpAuthAdapter {
  // Normalize the instance / factory forms: static OAuth config is read up front
  // (it never depends on the request), while getAuthInstance() is deferred to the
  // few code paths that actually call the better-auth API.
  const resolved = isFactory(auth)
    ? {
        base: auth.baseURL,
        ownSecret: auth.secret,
        expiresIn: auth.sessionExpiresIn ?? 3600,
        getAuthInstance: () => Promise.resolve(auth.getAuth()),
      }
    : {
        base: auth.options.baseURL,
        ownSecret: auth.options.secret,
        expiresIn: auth.options.session?.expiresIn ?? 3600,
        getAuthInstance: () => Promise.resolve(auth),
      };

  const base = resolved.base;
  const expiresIn = resolved.expiresIn;
  const getAuthInstance = resolved.getAuthInstance;
  const secret = options?.stateful
    ? undefined
    : (options?.secret ?? resolved.ownSecret);
  if (secret && secret.length < 32) {
    throw new Error(
      "zenstack-mcp: better-auth stateless secret must be at least 32 characters",
    );
  }
  const refreshTokenExpiresIn =
    options?.refreshTokenExpiresIn ?? 30 * 24 * 3600;
  // RFC 8707: the canonical resource this server protects. Stateless access
  // tokens carry it as `aud` and validateToken rejects any other audience.
  const resource = options?.resource ?? base;

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
            { user: userPayload, exp: Date.now() + expiresIn * 1000, aud: resource },
            secret,
          );
          const refreshToken = await signRefreshToken(
            {
              sessionToken,
              exp: Date.now() + refreshTokenExpiresIn * 1000,
              jti: randomToken(),
            },
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

      mountDiscoveryRoutes(router, {
        issuer: () => base,
        resource: () => resource,
        grantTypes: secret
          ? ["authorization_code", "refresh_token"]
          : ["authorization_code"],
      });

      router.post(
        "/register",
        createRegisterHandler({
          initialAccessToken: options?.initialAccessToken,
          grantTypes: ["authorization_code"],
          registerClient,
        }),
      );

      router.get(
        "/oauth/authorize",
        createAuthorizeHandler({
          resolveAllowedUris,
          getLoginPage: () => {
            const customPage = options?.loginPage;
            return customPage
              ? typeof customPage === "function"
                ? customPage()
                : customPage
              : loginPage();
          },
          expectedResource: () => resource,
        }),
      );

      router.post(
        "/login",
        createLoginHandler({
          resolveAllowedUris,
          authenticate: async (email, password) => {
            try {
              const result = await (await getAuthInstance()).api.signInEmail({
                body: { email, password },
              });
              if (!result?.token) return null;
              return {
                sessionToken: result.token as string,
                userPayload: result.user as unknown,
              };
            } catch {
              return null; // authentication failed
            }
          },
          issueCode: (auth, codeChallenge) =>
            issueCode(auth.userPayload, auth.sessionToken, codeChallenge),
        }),
      );

      router.post("/oauth/token", async (req) => {
        const body = (await req.body()) as Record<string, string>;
        const { grant_type } = body;

        // RFC 8707: a token request naming a foreign resource must not be honored.
        const resourceError = checkResource(body.resource, resource);
        if (resourceError) return resourceError;

        if (grant_type === "refresh_token") {
          if (!secret) return oauthError(400, "unsupported_grant_type");
          const { refresh_token } = body;
          if (!refresh_token) return oauthError(400, "invalid_request");
          const rtPayload = await verifyRefreshToken(refresh_token, secret);
          if (!rtPayload) return oauthError(400, "invalid_grant");
          // One-time-use rotation (opt-in): reject a token id we've already seen — the
          // signature of a stolen-token replay — then mark this one consumed.
          if (options?.refreshTokenReuse && rtPayload.jti) {
            if (await options.refreshTokenReuse.isConsumed(rtPayload.jti))
              return oauthError(400, "invalid_grant");
            await options.refreshTokenReuse.consume(rtPayload.jti, rtPayload.exp);
          }
          // One DB call — validates the session is still alive and gets fresh user data.
          const session = await (await getAuthInstance()).api.getSession({
            headers: new Headers({
              authorization: `Bearer ${rtPayload.sessionToken}`,
            }),
          });
          if (!session) return oauthError(400, "invalid_grant");
          const accessToken = await signAccessToken(
            { user: session.user, exp: Date.now() + expiresIn * 1000, aud: resource },
            secret,
          );
          const newRefreshToken = await signRefreshToken(
            {
              sessionToken: rtPayload.sessionToken,
              exp: rtPayload.exp,
              jti: randomToken(),
            },
            secret,
          );
          return {
            type: "json",
            data: {
              access_token: accessToken,
              refresh_token: newRefreshToken,
              token_type: "bearer",
              expires_in: expiresIn,
              // Report the actual remaining lifetime of the re-issued refresh token
              // (same exp as the original), not the full configured TTL.
              refresh_token_expires_in: Math.max(
                0,
                Math.floor((rtPayload.exp - Date.now()) / 1000),
              ),
            },
          };
        }

        if (grant_type !== "authorization_code")
          return oauthError(400, "unsupported_grant_type");
        const { code, code_verifier } = body;
        if (!code || !code_verifier) return oauthError(400, "invalid_request");

        const entry = await redeemCode(code);
        if (!entry) return oauthError(400, "invalid_grant");
        if (!(await pkceVerify(code_verifier, entry.codeChallenge)))
          return oauthError(400, "invalid_grant");

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
        // The audience must be this server's resource (RFC 8707): a token signed
        // with the same secret but minted for another service is rejected.
        const payload = await verifyAccessToken(token, secret);
        if (!payload || payload.aud !== resource)
          throw new Error("Invalid or expired token");
        return payload.user;
      }
      // Stateful: session lookup via better-auth catches immediate revocations.
      const session = await (await getAuthInstance()).api.getSession({
        headers: new Headers({ authorization: `Bearer ${token}` }),
      });
      if (!session) throw new Error("Invalid or expired token");
      return session.user;
    },
  };
}

// Public re-exports for hosts that need to mint or verify access tokens
// themselves (e.g. a server-side agent calling its own /mcp endpoint on behalf
// of an already-authenticated user). Tokens minted with `signAccessToken` must
// carry `exp` in epoch milliseconds and `aud` set to the adapter's canonical
// resource (defaults to the better-auth `baseURL`) or `validateToken` rejects
// them.
export {
  signAccessToken,
  verifyAccessToken,
  type AccessTokenPayload,
} from "./stateless.js";
