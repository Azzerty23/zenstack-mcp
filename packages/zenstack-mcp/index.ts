// ZenStack CLI plugin (default export for zen generate)
export { default } from './src/plugin/index.js'

// Shared types
export type { McpConfig, McpModelDef, McpFieldDef, McpOperation, McpAuthAdapter, McpBuiltInAuthOptions, McpServerConfig, TokenStore } from './src/types.js'

// Request context — access the authenticated user from anywhere within a request handler
export { getRequestUser } from './src/context.js'

// Token store — export the interface and default in-memory factory so users can implement custom stores
export { createInMemoryTokenStore } from './src/auth-adapters/oauth/store.js'

// Login page utilities — for injecting the built-in login script into custom HTML
export { injectLoginScript } from './src/auth-adapters/login-page.js'
