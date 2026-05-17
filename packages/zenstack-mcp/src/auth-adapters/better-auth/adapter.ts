import type { McpAuthAdapter, RouterAdapter } from '../../types.js'
import { injectLoginScript, loginPage } from '../login-page.js'
import { createInMemoryTokenStore, pkceVerify, randomCode } from '../oauth/store.js'

/**
 * Creates an MCP auth adapter for a better-auth instance.
 *
 * Note: this adapter stores short-lived PKCE authorization codes in memory.
 * This is acceptable because codes expire in 5 minutes and are used only
 * during the OAuth handshake. Actual session persistence is managed by
 * better-auth itself (database-backed by default).
 *
 * Usage:
 * ```ts
 * import { betterAuthMcpAdapter } from 'zenstack-mcp/auth-adapters/better-auth'
 * import { auth } from '~/lib/auth'
 *
 * const { oauthRoutes, mcpMiddleware } = createHonoMcpHandler({
 *   auth: betterAuthMcpAdapter(auth),
 *   ...
 * })
 * ```
 */
export function betterAuthMcpAdapter(
  auth: {
    options: {
      baseURL: string
      /** better-auth session config — read to align expires_in with the actual session TTL */
      session?: { expiresIn?: number }
    }
    api: {
      getSession(opts: { headers: Headers }): Promise<{ user: unknown } | null>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      signInEmail(opts: { body: { email: string; password: string } }): Promise<any>
    }
  },
  options?: {
    /** Override the default login page. Accepts an HTML string or an async function returning one. */
    loginPage?: string | (() => string | Promise<string>)
  },
): McpAuthAdapter {
  const store = createInMemoryTokenStore()
  const base = auth.options.baseURL
  // Mirror the session TTL from better-auth config so MCP clients refresh at the right time.
  // auth.options.session.expiresIn is the same value passed to betterAuth({ session: { expiresIn } }).
  const expiresIn = auth.options.session?.expiresIn ?? 3600

  return {
    mountRoutes(router: RouterAdapter) {
      // Persists redirect_uris declared at registration time so that /login and /oauth/authorize
      // can validate the redirect_uri against this allowlist — prevents open redirect attacks where
      // a crafted redirect_uri would redirect the authorization code to an attacker-controlled URI.
      const clientRegistry = new Map<string, string[]>() // client_id → registered redirect_uris

      router.get('/.well-known/oauth-authorization-server', () => ({
        type: 'json',
        data: {
          issuer: base,
          authorization_endpoint: `${base}/oauth/authorize`,
          token_endpoint: `${base}/oauth/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
          grant_types_supported: ['authorization_code'],
        },
      }))

      router.get('/.well-known/oauth-protected-resource', () => ({
        type: 'json',
        data: {
          resource: base,
          authorization_servers: [base],
          bearer_methods_supported: ['header'],
        },
      }))

      router.post('/register', async (req) => {
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
            grant_types: ['authorization_code'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
          },
        }
      })

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
          const customPage = options?.loginPage
          const html = customPage
            ? await (typeof customPage === 'function' ? customPage() : customPage)
            : loginPage()
          return { type: 'html', html: injectLoginScript(html) }
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

        let token: string | undefined
        try {
          const result = await auth.api.signInEmail({ body: { email: String(email), password: String(password) } })
          token = result?.token
        } catch {
          // fall through to error response
        }

        if (!token) return { type: 'json', status: 401, data: { error: 'Invalid credentials' } }

        const code = randomCode()
        await store.saveCode(code, token, String(code_challenge), Date.now() + 5 * 60 * 1000)

        const redirectUrl = new URL(String(redirect_uri))
        redirectUrl.searchParams.set('code', code)
        if (state) redirectUrl.searchParams.set('state', String(state))
        return { type: 'json', data: { redirectUrl: redirectUrl.toString() } }
      })

      router.post('/oauth/token', async (req) => {
        const body = await req.body()
        const { grant_type, code, code_verifier } = body as Record<string, string>
        if (grant_type !== 'authorization_code')
          return { type: 'json', status: 400, data: { error: 'unsupported_grant_type' } }
        if (!code || !code_verifier)
          return { type: 'json', status: 400, data: { error: 'invalid_request' } }

        const entry = await store.takeCode(String(code))
        if (!entry)
          return { type: 'json', status: 400, data: { error: 'invalid_grant' } }
        if (!(await pkceVerify(String(code_verifier), entry.codeChallenge)))
          return { type: 'json', status: 400, data: { error: 'invalid_grant' } }

        return { type: 'json', data: { access_token: entry.user, token_type: 'bearer', expires_in: expiresIn } }
      })
    },

    validateToken: async (token: string) => {
      const session = await auth.api.getSession({
        headers: new Headers({ authorization: `Bearer ${token}` }),
      })
      if (!session) throw new Error('Invalid or expired token')
      return session.user
    },
  }
}
