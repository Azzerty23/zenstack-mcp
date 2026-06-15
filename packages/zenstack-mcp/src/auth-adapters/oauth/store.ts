import type { TokenStore } from '../../types.js'

export type { TokenStore }

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function randomCode(): string {
  return randomHex(32)
}

export function randomToken(): string {
  return randomHex(32)
}

export async function pkceVerify(verifier: string, challenge: string): Promise<boolean> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  const computed = btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return computed === challenge
}

// Evicts stale entries on every write. Abandoned OAuth flows (browser closed before code
// exchange) would otherwise leave expired codes and refresh tokens in the Maps forever.
// Lazy eviction on save keeps the implementation timer-free and serverless-compatible.
function purgeExpired<T extends { expiresAt: number }>(map: Map<string, T>): void {
  const now = Date.now()
  for (const [key, val] of map) {
    if (now > val.expiresAt) map.delete(key)
  }
}

export function createInMemoryTokenStore(): TokenStore {
  const codes = new Map<string, { user: unknown; codeChallenge: string; expiresAt: number }>()
  const refreshTokens = new Map<string, { user: unknown; expiresAt: number }>()

  return {
    async saveCode(code, user, codeChallenge, expiresAt) {
      purgeExpired(codes)
      codes.set(code, { user, codeChallenge, expiresAt })
    },
    // takeCode deletes on first access (one-time use). Concurrent calls for the
    // same code will race — one wins, others get null. This is intentional: codes
    // are 64-hex-char nonces that expire in 5 minutes, so parallel brute-force
    // is not a practical threat.
    async takeCode(code) {
      const entry = codes.get(code)
      if (!entry) return null
      codes.delete(code)
      if (Date.now() > entry.expiresAt) return null
      return entry
    },
    async saveRefreshToken(token, user, expiresAt) {
      purgeExpired(refreshTokens)
      refreshTokens.set(token, { user, expiresAt })
    },
    async takeRefreshToken(token) {
      const entry = refreshTokens.get(token)
      if (!entry) return null
      refreshTokens.delete(token)
      if (Date.now() > entry.expiresAt) return null
      return entry
    },
    async revokeRefreshToken(token) {
      refreshTokens.delete(token)
    },
  }
}
