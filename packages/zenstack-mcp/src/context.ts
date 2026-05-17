import { AsyncLocalStorage } from 'node:async_hooks'

export const requestContext = new AsyncLocalStorage<{ user: unknown }>()

/**
 * Returns the authenticated user for the current request, or `undefined` when
 * called outside a zenstack-mcp request context (e.g. public/unauthenticated
 * access). ZenStack's access policies treat an `undefined` user as an anonymous
 * caller — expose only what your policies allow for `@@allow('read', true)` etc.
 */
export function getRequestUser(): unknown | undefined {
  return requestContext.getStore()?.user
}
