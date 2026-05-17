import type { RouterAdapter, McpBuiltInAuthOptions } from '../../types.js'
import { createInMemoryTokenStore, pkceVerify, randomCode, randomToken } from './store.js'
import { signToken } from './jwt.js'
import { injectLoginScript, loginPage as defaultLoginPage } from '../login-page.js'

export function mountOAuthRoutes(router: RouterAdapter, options: McpBuiltInAuthOptions): void {
  const ttl = options.tokenTtl ?? 3600
  const refreshTtl = options.refreshTokenTtl ?? 30 * 24 * 3600
  const maxClients = options.maxClients ?? 100
  const store = options.tokenStore ?? createInMemoryTokenStore()
  // Persists redirect_uris declared at registration time so that /login and /oauth/authorize
  // can validate the redirect_uri against this allowlist — prevents open redirect attacks where
  // a crafted redirect_uri would redirect the authorization code to an attacker-controlled URI.
  const clientRegistry = new Map<string, string[]>() // client_id → registered redirect_uris

  router.get('/.well-known/oauth-authorization-server', (req) => ({
    type: 'json',
    data: {
      issuer: req.origin,
      authorization_endpoint: `${req.origin}/oauth/authorize`,
      token_endpoint: `${req.origin}/oauth/token`,
      revocation_endpoint: `${req.origin}/oauth/revoke`,
      registration_endpoint: `${req.origin}/register`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
    },
  }))

  router.get('/.well-known/oauth-protected-resource', (req) => ({
    type: 'json',
    data: {
      resource: req.origin,
      authorization_servers: [req.origin],
      bearer_methods_supported: ['header'],
    },
  }))

  router.post('/register', async (req) => {
    if (clientRegistry.size >= maxClients)
      return { type: 'json', status: 429, data: { error: 'too_many_clients' } }

    if (options.initialAccessToken) {
      const expected = `Bearer ${options.initialAccessToken}`
      if (req.authorization !== expected)
        return { type: 'json', status: 401, data: { error: 'invalid_token' } }
    }

    const body = await req.body()
    const clientId = crypto.randomUUID()
    const redirectUris = (body.redirect_uris as string[] | undefined) ?? []
    clientRegistry.set(clientId, redirectUris)
    return {
      type: 'json',
      status: 201,
      data: {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
    }
  })

  const getLoginPage = options.loginPage
    ? typeof options.loginPage === 'function' ? options.loginPage : () => options.loginPage as string
    : defaultLoginPage

  router.get('/oauth/authorize', async (req) => {
    const { redirect_uri, code_challenge, client_id, code_challenge_method } = req.query
    if (!redirect_uri || !code_challenge || !client_id)
      return { type: 'json', status: 400, data: { error: 'invalid_request' } }
    if (code_challenge_method && code_challenge_method !== 'S256')
      return { type: 'json', status: 400, data: { error: 'invalid_request', error_description: 'Only S256 code_challenge_method is supported' } }
    const allowedUris = clientRegistry.get(String(client_id))
    if (!allowedUris)
      return { type: 'json', status: 400, data: { error: 'invalid_client' } }
    if (!allowedUris.includes(String(redirect_uri)))
      return { type: 'json', status: 400, data: { error: 'invalid_redirect_uri' } }
    try {
      return { type: 'html', html: injectLoginScript(await getLoginPage()) }
    } catch {
      return { type: 'json', status: 500, data: { error: 'server_error', error_description: 'Failed to render login page' } }
    }
  })

  router.post('/login', async (req) => {
    const body = await req.body()
    const { email, password, redirect_uri, code_challenge, state, client_id } = body as Record<string, string>

    // Validate again at login time: the form could bypass /oauth/authorize and POST directly
    // with an arbitrary redirect_uri, so the allowlist check must be enforced here too.
    const allowedUris = client_id ? clientRegistry.get(String(client_id)) : undefined
    if (!allowedUris)
      return { type: 'json', status: 400, data: { error: 'invalid_client' } }
    if (!allowedUris.includes(String(redirect_uri)))
      return { type: 'json', status: 400, data: { error: 'invalid_redirect_uri' } }

    const user = await options.validateCredentials(String(email ?? ''), String(password ?? ''))
    if (!user) return { type: 'json', status: 401, data: { error: 'Invalid credentials' } }

    const code = randomCode()
    await store.saveCode(code, user, String(code_challenge), Date.now() + 5 * 60 * 1000)

    const redirectUrl = new URL(String(redirect_uri))
    redirectUrl.searchParams.set('code', code)
    if (state) redirectUrl.searchParams.set('state', String(state))
    return { type: 'json', data: { redirectUrl: redirectUrl.toString() } }
  })

  router.post('/oauth/token', async (req) => {
    const body = await req.body()
    const { grant_type, code, code_verifier, refresh_token } = body as Record<string, string>

    if (grant_type === 'refresh_token') {
      if (!refresh_token) return { type: 'json', status: 400, data: { error: 'invalid_request' } }
      const entry = await store.takeRefreshToken(String(refresh_token))
      if (!entry) return { type: 'json', status: 400, data: { error: 'invalid_grant' } }
      const accessToken = await signToken(entry.user, options.jwtSecret, ttl)
      const newRefreshToken = randomToken()
      await store.saveRefreshToken(newRefreshToken, entry.user, Date.now() + refreshTtl * 1000)
      return { type: 'json', data: { access_token: accessToken, refresh_token: newRefreshToken, token_type: 'bearer', expires_in: ttl } }
    }

    if (grant_type !== 'authorization_code') return { type: 'json', status: 400, data: { error: 'unsupported_grant_type' } }
    if (!code || !code_verifier) return { type: 'json', status: 400, data: { error: 'invalid_request' } }

    const entry = await store.takeCode(String(code))
    if (!entry) return { type: 'json', status: 400, data: { error: 'invalid_grant' } }
    if (!(await pkceVerify(String(code_verifier), entry.codeChallenge))) return { type: 'json', status: 400, data: { error: 'invalid_grant' } }

    const accessToken = await signToken(entry.user, options.jwtSecret, ttl)
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
