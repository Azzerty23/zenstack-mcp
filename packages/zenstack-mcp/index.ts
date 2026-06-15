// ZenStack CLI plugin (default export for zen generate)
export { default } from './src/plugin/index.js'

// Shared types
export type { McpConfig, McpModelDef, McpFieldDef, McpOperation, McpAuthAdapter, McpBuiltInAuthOptions, McpServerConfig, TokenStore, MutationPublisher, ModelMutationEvent } from './src/types.js'

// Mutation publisher — export the default in-memory factory and channel helper so users can plug a distributed publisher (e.g. @viiite/server's Durable-Object-backed one)
export { createInMemoryPublisher, defaultChannel } from './src/events/publisher.js'

// MCP resource notifications — building blocks for stateful adapters (e.g. a Durable-Object MCP session) to expose models as subscribable resources and push resources/updated on mutations
export { registerModelResources, bridgeModelMutations, modelResourceUri } from './src/events/notifications.js'
export type { BridgeMutationsOptions } from './src/events/notifications.js'

// Request context — access the authenticated user from anywhere within a request handler
export { getRequestUser } from './src/context.js'

// Token store — export the interface and default in-memory factory so users can implement custom stores
export { createInMemoryTokenStore } from './src/auth-adapters/oauth/store.js'

// Login page utilities — for injecting the built-in login script into custom HTML
export { injectLoginScript } from './src/auth-adapters/login-page.js'
