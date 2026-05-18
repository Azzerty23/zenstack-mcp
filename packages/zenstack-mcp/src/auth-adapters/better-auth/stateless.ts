/**
 * Stateless crypto helpers for the betterAuthMcpAdapter.
 *
 * When a `secret` is provided, these replace the two in-memory Maps:
 *  - clientRegistry  → HMAC-signed client_id    (redirect_uris embedded, no storage)
 *  - PKCE code store → AES-GCM encrypted code   (payload embedded, no storage)
 *
 * This makes the OAuth flow fully stateless and safe for multi-instance
 * serverless environments (Cloudflare Workers, Lambda, etc.) where in-memory
 * state is lost between requests.
 */

function base64urlEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function base64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const binary = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes as Uint8Array<ArrayBuffer>
}

// Module-level key caches — derived once per secret per process/isolate, reused across requests.
const aesKeyCache = new Map<string, Promise<CryptoKey>>()
const hmacKeyCache = new Map<string, Promise<CryptoKey>>()

type KeyUsage = 'decrypt' | 'deriveBits' | 'deriveKey' | 'encrypt' | 'sign' | 'unwrapKey' | 'verify' | 'wrapKey'

async function aesKeyFromSecret(secret: string, usage: KeyUsage[]): Promise<CryptoKey> {
  const cacheKey = `${secret}:${usage.slice().sort().join(',')}`
  let p = aesKeyCache.get(cacheKey)
  if (!p) {
    p = crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
      .then(raw => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, usage))
    aesKeyCache.set(cacheKey, p)
  }
  return p
}

async function hmacKeyFromSecret(secret: string): Promise<CryptoKey> {
  let p = hmacKeyCache.get(secret)
  if (!p) {
    p = crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    )
    hmacKeyCache.set(secret, p)
  }
  return p
}

// ── Shared HMAC sign / verify ─────────────────────────────────────────────────
// Used by both client_id and access token — same format: base64url(data).base64url(sig)

async function hmacSign(data: string, secret: string): Promise<string> {
  const key = await hmacKeyFromSecret(secret)
  const encoded = new TextEncoder().encode(data)
  const sig = await crypto.subtle.sign('HMAC', key, encoded)
  return `${base64urlEncode(encoded)}.${base64urlEncode(sig)}`
}

async function hmacVerify(token: string, secret: string): Promise<string | null> {
  const dot = token.lastIndexOf('.')
  if (dot === -1) return null
  try {
    const dataB64 = token.slice(0, dot)
    const sigB64 = token.slice(dot + 1)
    const data = base64urlDecode(dataB64)
    const sig = base64urlDecode(sigB64)
    const key = await hmacKeyFromSecret(secret)
    const ok = await crypto.subtle.verify('HMAC', key, sig, data)
    if (!ok) return null
    return new TextDecoder().decode(data)
  } catch {
    return null
  }
}

// ── Client ID (HMAC-signed) ───────────────────────────────────────────────────

/**
 * Returns a client_id that encodes `redirectUris` and is HMAC-signed with `secret`.
 * Format: `base64url(data).base64url(hmac)`
 */
export async function signClientId(redirectUris: string[], secret: string): Promise<string> {
  return hmacSign(JSON.stringify(redirectUris), secret)
}

/**
 * Verifies the HMAC signature and returns the redirect_uris embedded in the client_id.
 * Returns null if the signature is invalid or the format is malformed.
 */
export async function verifyClientId(clientId: string, secret: string): Promise<string[] | null> {
  const data = await hmacVerify(clientId, secret)
  if (!data) return null
  try {
    return JSON.parse(data) as string[]
  } catch {
    return null
  }
}

// ── PKCE Code (AES-GCM encrypted) ────────────────────────────────────────────

interface CodePayload {
  user: unknown
  /** Signed refresh token embedded alongside the access token, stateless mode only. */
  refreshToken?: string
  codeChallenge: string
  expiresAt: number
}

/**
 * Encrypts a PKCE code payload with AES-GCM.
 * Format: `base64url(iv || ciphertext+tag)` — the auth tag is appended by SubtleCrypto.
 */
export async function encryptCode(payload: CodePayload, secret: string): Promise<string> {
  const key = await aesKeyFromSecret(secret, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = new TextEncoder().encode(JSON.stringify(payload))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data)
  const combined = new Uint8Array(iv.length + ciphertext.byteLength)
  combined.set(iv)
  combined.set(new Uint8Array(ciphertext), iv.length)
  return base64urlEncode(combined)
}

/**
 * Decrypts a PKCE code and returns the payload, or null if expired / invalid.
 */
export async function decryptCode(encoded: string, secret: string): Promise<CodePayload | null> {
  try {
    const combined = base64urlDecode(encoded)
    const iv = combined.slice(0, 12)
    const ciphertext = combined.slice(12)
    const key = await aesKeyFromSecret(secret, ['decrypt'])
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
    const payload = JSON.parse(new TextDecoder().decode(plaintext)) as CodePayload
    if (Date.now() > payload.expiresAt) return null
    return payload
  } catch {
    return null
  }
}

// ── Generic HMAC-signed payload ───────────────────────────────────────────────
// Access tokens and refresh tokens share the same sign/verify structure — both
// are HMAC-signed JSON payloads with an `exp` field. A single generic pair
// handles both, parameterised by the payload type.

async function signPayload<T>(payload: T, secret: string): Promise<string> {
  return hmacSign(JSON.stringify(payload), secret)
}

async function verifyPayload<T extends { exp: number }>(token: string, secret: string): Promise<T | null> {
  const data = await hmacVerify(token, secret)
  if (!data) return null
  try {
    const payload = JSON.parse(data) as T
    if (Date.now() > payload.exp) return null
    return payload
  } catch {
    return null
  }
}

// ── Access Token (HMAC-signed) ────────────────────────────────────────────────

export interface AccessTokenPayload {
  user: unknown
  exp: number
}

/**
 * Creates a signed access token embedding user data.
 * Format: `base64url(payload).base64url(hmac)`
 *
 * The user object is embedded directly so MCP requests can be verified with a
 * crypto operation instead of a database round-trip.
 */
export async function signAccessToken(payload: AccessTokenPayload, secret: string): Promise<string> {
  return signPayload(payload, secret)
}

/**
 * Verifies a signed access token and returns the payload, or null if invalid/expired.
 */
export async function verifyAccessToken(token: string, secret: string): Promise<AccessTokenPayload | null> {
  return verifyPayload<AccessTokenPayload>(token, secret)
}

// ── Refresh Token (HMAC-signed, wraps the better-auth session token) ─────────

export interface RefreshTokenPayload {
  /** The opaque better-auth session token — passed to getSession() on refresh. */
  sessionToken: string
  exp: number
}

/**
 * Creates a signed refresh token wrapping the better-auth session token.
 * On refresh, the session token is extracted and passed to auth.api.getSession()
 * to validate liveness and fetch fresh user data — one DB call, infrequent.
 */
export async function signRefreshToken(payload: RefreshTokenPayload, secret: string): Promise<string> {
  return signPayload(payload, secret)
}

/**
 * Verifies a signed refresh token and returns the payload, or null if invalid/expired.
 */
export async function verifyRefreshToken(token: string, secret: string): Promise<RefreshTokenPayload | null> {
  return verifyPayload<RefreshTokenPayload>(token, secret)
}
