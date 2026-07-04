import type { RouterAdapter, McpBuiltInAuthOptions, GenericRequest } from '../../types.js'
import { createInMemoryTokenStore, pkceVerify, randomCode, randomToken } from './store.js'
import { signToken } from './jwt.js'
import {
  checkResource,
  createAuthorizeHandler,
  createLoginHandler,
  createRegisterHandler,
  mountDiscoveryRoutes,
  oauthError,
} from '../shared.js'
import { loginPage as defaultLoginPage } from '../login-page.js'

const GRANT_TYPES = ['authorization_code', 'refresh_token'] as const

export function mountOAuthRoutes(router: RouterAdapter, options: McpBuiltInAuthOptions): void {
  const ttl = options.tokenTtl ?? 3600
  const refreshTtl = options.refreshTokenTtl ?? 30 * 24 * 3600
  const maxClients = options.maxClients ?? 100
  const clientTtl = (options.clientTtl ?? 24 * 3600) * 1000
  const store = options.tokenStore ?? createInMemoryTokenStore()
  // RFC 8707: the canonical resource this server protects. Access tokens are
  // minted with this value as `aud` and validated against it on every MCP
  // request (see builtInMcpAuth.validateToken).
  const expectedResource = (req: GenericRequest) => options.resource ?? req.origin

  // Persists redirect_uris declared at registration time so that /login and /oauth/authorize
  // can validate the redirect_uri against this allowlist — prevents open redirect attacks where
  // a crafted redirect_uri would redirect the authorization code to an attacker-controlled URI.
  const clientRegistry = new Map<string, { redirectUris: string[]; expiresAt: number }>()

  // Evict clients that outlived clientTtl. Without this, an open /register endpoint lets an
  // unauthenticated caller fill the registry to maxClients and permanently lock out new clients.
  function purgeExpiredClients(): void {
    const now = Date.now()
    for (const [id, entry] of clientRegistry) {
      if (now > entry.expiresAt) clientRegistry.delete(id)
    }
  }

  // Returns the registered redirect_uris for a client, or undefined if unknown/expired.
  function getClientUris(clientId: string): string[] | undefined {
    const entry = clientRegistry.get(clientId)
    if (!entry) return undefined
    if (Date.now() > entry.expiresAt) {
      clientRegistry.delete(clientId)
      return undefined
    }
    return entry.redirectUris
  }

  mountDiscoveryRoutes(router, {
    issuer: (req) => req.origin,
    resource: expectedResource,
    grantTypes: GRANT_TYPES,
    revocation: true,
  })

  router.post(
    '/register',
    createRegisterHandler({
      initialAccessToken: options.initialAccessToken,
      grantTypes: GRANT_TYPES,
      registerClient: (redirectUris) => {
        purgeExpiredClients()
        if (clientRegistry.size >= maxClients) return null
        const clientId = crypto.randomUUID()
        clientRegistry.set(clientId, { redirectUris, expiresAt: Date.now() + clientTtl })
        return clientId
      },
    }),
  )

  const getLoginPage = options.loginPage
    ? typeof options.loginPage === 'function' ? options.loginPage : () => options.loginPage as string
    : defaultLoginPage

  router.get(
    '/oauth/authorize',
    createAuthorizeHandler({
      resolveAllowedUris: getClientUris,
      getLoginPage,
      expectedResource,
    }),
  )

  router.post(
    '/login',
    createLoginHandler({
      resolveAllowedUris: getClientUris,
      authenticate: (email, password) => options.validateCredentials(email, password),
      issueCode: async (user, codeChallenge) => {
        const code = randomCode()
        await store.saveCode(code, user, codeChallenge, Date.now() + 5 * 60 * 1000)
        return code
      },
    }),
  )

  router.post('/oauth/token', async (req) => {
    const body = await req.body()
    const { grant_type, code, code_verifier, refresh_token } = body as Record<string, string>

    // RFC 8707: a token request naming a foreign resource must not be honored.
    const audience = expectedResource(req)
    const resourceError = checkResource(body.resource, audience)
    if (resourceError) return resourceError

    if (grant_type === 'refresh_token') {
      if (!refresh_token) return oauthError(400, 'invalid_request')
      const entry = await store.takeRefreshToken(String(refresh_token))
      if (!entry) return oauthError(400, 'invalid_grant')
      const accessToken = await signToken(entry.user, options.jwtSecret, ttl, audience)
      const newRefreshToken = randomToken()
      await store.saveRefreshToken(newRefreshToken, entry.user, Date.now() + refreshTtl * 1000)
      return { type: 'json', data: { access_token: accessToken, refresh_token: newRefreshToken, token_type: 'bearer', expires_in: ttl } }
    }

    if (grant_type !== 'authorization_code') return oauthError(400, 'unsupported_grant_type')
    if (!code || !code_verifier) return oauthError(400, 'invalid_request')

    const entry = await store.takeCode(String(code))
    if (!entry) return oauthError(400, 'invalid_grant')
    if (!(await pkceVerify(String(code_verifier), entry.codeChallenge))) return oauthError(400, 'invalid_grant')

    const accessToken = await signToken(entry.user, options.jwtSecret, ttl, audience)
    const newRefreshToken = randomToken()
    await store.saveRefreshToken(newRefreshToken, entry.user, Date.now() + refreshTtl * 1000)
    return { type: 'json', data: { access_token: accessToken, refresh_token: newRefreshToken, token_type: 'bearer', expires_in: ttl } }
  })

  router.post('/oauth/revoke', async (req) => {
    const body = await req.body()
    const { token } = body as Record<string, string>
    if (token) await store.revokeRefreshToken(String(token))
    return { type: 'json', data: {} }
  })
}
