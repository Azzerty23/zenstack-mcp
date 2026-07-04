/**
 * OAuth endpoint logic shared by the built-in OAuth server and the better-auth
 * adapter. Both expose the same protocol surface (discovery metadata, dynamic
 * client registration, /oauth/authorize, /login); only where clients/codes are
 * stored and how credentials are checked differs — those vary per adapter and
 * are injected as callbacks. Keeping the protocol logic in one place means a
 * security fix lands in both adapters at once.
 */
import type { GenericRequest, GenericResponse, RouteHandler, RouterAdapter } from '../types.js'
import { normalizeRedirectUris } from './oauth/redirect-uri.js'
import { injectLoginScript } from './login-page.js'

/** Shorthand for an OAuth-style JSON error response. */
export function oauthError(status: number, error: string, description?: string): GenericResponse {
  return {
    type: 'json',
    status,
    data: description ? { error, error_description: description } : { error },
  }
}

/**
 * RFC 8707 resource indicator check: when a request names a target `resource`,
 * it must be the one this server protects — otherwise a token minted here could
 * be intended for (and later replayed against) a different service. A resource
 * on the same origin as the expected one is accepted, since clients commonly
 * send the full MCP endpoint URL rather than the bare origin.
 *
 * Returns an `invalid_target` error response on mismatch, undefined when
 * absent or acceptable.
 */
export function checkResource(requested: unknown, expected: string): GenericResponse | undefined {
  if (requested === undefined || requested === null || requested === '') return undefined
  const value = String(requested)
  if (value === expected) return undefined
  try {
    if (new URL(value).origin === new URL(expected).origin) return undefined
  } catch {
    // fall through to the error below
  }
  return oauthError(400, 'invalid_target', `This server only issues tokens for resource "${expected}"`)
}

export interface DiscoveryRouteOptions {
  /** OAuth issuer / endpoint base for this server (no trailing slash). */
  issuer: (req: GenericRequest) => string
  /** Canonical resource identifier advertised in the protected-resource metadata (default: issuer). */
  resource?: (req: GenericRequest) => string
  /** Grant types advertised in the authorization-server metadata. */
  grantTypes: readonly string[]
  /** Advertise a `/oauth/revoke` endpoint. */
  revocation?: boolean
}

export function mountDiscoveryRoutes(router: RouterAdapter, opts: DiscoveryRouteOptions): void {
  router.get('/.well-known/oauth-authorization-server', (req) => {
    const issuer = opts.issuer(req)
    return {
      type: 'json',
      data: {
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        ...(opts.revocation ? { revocation_endpoint: `${issuer}/oauth/revoke` } : {}),
        registration_endpoint: `${issuer}/register`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        grant_types_supported: [...opts.grantTypes],
      },
    }
  })

  const protectedResourceMetadata = (req: GenericRequest): GenericResponse => ({
    type: 'json',
    data: {
      resource: (opts.resource ?? opts.issuer)(req),
      authorization_servers: [opts.issuer(req)],
      bearer_methods_supported: ['header'],
    },
  })

  router.get('/.well-known/oauth-protected-resource', protectedResourceMetadata)

  // RFC 9728 §3.1: clients probe the path-specific metadata
  // (/.well-known/oauth-protected-resource/<resource>) before falling back to the
  // root. Register the single-segment variant so common mounts (e.g. /mcp) don't
  // 404. `:resource` is the syntax shared by both Hono and Express 5 routers.
  router.get('/.well-known/oauth-protected-resource/:resource', protectedResourceMetadata)
}

export interface RegisterHandlerOptions {
  /** RFC 7591 initial access token; when set, POST /register requires it as a Bearer. */
  initialAccessToken?: string
  /** grant_types echoed in the registration response. */
  grantTypes: readonly string[]
  /** Persist or sign the client; returns the client_id, or null when the registry is full. */
  registerClient: (redirectUris: string[]) => string | null | Promise<string | null>
}

export function createRegisterHandler(opts: RegisterHandlerOptions): RouteHandler {
  return async (req) => {
    if (opts.initialAccessToken && req.authorization !== `Bearer ${opts.initialAccessToken}`) {
      return oauthError(401, 'invalid_token')
    }

    const body = (await req.body()) as { redirect_uris?: unknown }
    const redirectUris = normalizeRedirectUris(body.redirect_uris)
    if (!redirectUris) return oauthError(400, 'invalid_redirect_uri')

    const clientId = await opts.registerClient(redirectUris)
    if (!clientId) return oauthError(429, 'too_many_clients')

    return {
      type: 'json',
      status: 201,
      data: {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: redirectUris,
        grant_types: [...opts.grantTypes],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
    }
  }
}

/** Returns the redirect_uris registered for a client, or null/undefined if unknown. */
type ResolveAllowedUris = (
  clientId: string,
) => string[] | null | undefined | Promise<string[] | null | undefined>

export interface AuthorizeHandlerOptions {
  resolveAllowedUris: ResolveAllowedUris
  getLoginPage: () => string | Promise<string>
  /** Canonical resource this server protects (RFC 8707); mismatching `resource` params are rejected. */
  expectedResource: (req: GenericRequest) => string
}

export function createAuthorizeHandler(opts: AuthorizeHandlerOptions): RouteHandler {
  return async (req) => {
    const { redirect_uri, code_challenge, client_id, code_challenge_method, response_type, resource } =
      req.query
    if (!redirect_uri || !code_challenge || !client_id) return oauthError(400, 'invalid_request')
    if (response_type && response_type !== 'code') return oauthError(400, 'unsupported_response_type')
    if (code_challenge_method && code_challenge_method !== 'S256') {
      return oauthError(400, 'invalid_request', 'Only S256 code_challenge_method is supported')
    }
    const resourceError = checkResource(resource, opts.expectedResource(req))
    if (resourceError) return resourceError

    const allowedUris = await opts.resolveAllowedUris(String(client_id))
    if (!allowedUris) return oauthError(400, 'invalid_client')
    if (!allowedUris.includes(String(redirect_uri))) return oauthError(400, 'invalid_redirect_uri')

    try {
      return { type: 'html', html: injectLoginScript(await opts.getLoginPage()) }
    } catch {
      return oauthError(500, 'server_error', 'Failed to render login page')
    }
  }
}

export interface LoginHandlerOptions<TAuth> {
  resolveAllowedUris: ResolveAllowedUris
  /** Validate credentials; return an auth payload for issueCode, or null on failure. */
  authenticate: (email: string, password: string) => Promise<TAuth | null | undefined>
  /** Mint a one-time authorization code bound to the PKCE challenge. */
  issueCode: (auth: TAuth, codeChallenge: string) => Promise<string>
}

export function createLoginHandler<TAuth>(opts: LoginHandlerOptions<TAuth>): RouteHandler {
  return async (req) => {
    const body = (await req.body()) as Record<string, string>
    const { email, password, redirect_uri, code_challenge, state, client_id } = body

    if (!email || !password || !redirect_uri || !code_challenge) {
      return oauthError(400, 'invalid_request')
    }

    // Validate again at login time: the form could bypass /oauth/authorize and POST
    // directly with an arbitrary redirect_uri, so the allowlist check must be
    // enforced here too — otherwise the authorization code leaks to an
    // attacker-controlled URI.
    const allowedUris = client_id ? await opts.resolveAllowedUris(String(client_id)) : undefined
    if (!allowedUris) return oauthError(400, 'invalid_client')
    if (!allowedUris.includes(String(redirect_uri))) return oauthError(400, 'invalid_redirect_uri')

    const auth = await opts.authenticate(String(email), String(password))
    if (!auth) return { type: 'json', status: 401, data: { error: 'Invalid credentials' } }

    const code = await opts.issueCode(auth, String(code_challenge))
    const redirectUrl = new URL(String(redirect_uri))
    redirectUrl.searchParams.set('code', code)
    if (state) redirectUrl.searchParams.set('state', String(state))
    return { type: 'json', data: { redirectUrl: redirectUrl.toString() } }
  }
}
