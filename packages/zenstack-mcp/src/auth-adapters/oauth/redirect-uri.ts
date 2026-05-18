const LOOPBACK_IPV4_PATTERN = /^127\.(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){2}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '::1' || hostname === '[::1]' || LOOPBACK_IPV4_PATTERN.test(hostname)
}

export function isAllowedRedirectUri(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.username || url.password || url.hash) return false
    if (url.protocol === 'https:') return true
    return url.protocol === 'http:' && isLoopbackHost(url.hostname)
  } catch {
    return false
  }
}

export function normalizeRedirectUris(value: unknown): string[] | null {
  if (value === undefined) return null
  if (!Array.isArray(value)) return null
  if (!value.every((uri) => typeof uri === 'string')) return null

  const redirectUris = value as string[]
  if (!redirectUris.every((uri) => isAllowedRedirectUri(uri))) return null

  return [...new Set(redirectUris)]
}
