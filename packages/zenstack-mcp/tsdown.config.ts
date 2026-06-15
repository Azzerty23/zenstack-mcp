import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'index.ts',
    'server-adapters/hono': 'src/server-adapters/hono.ts',
    'server-adapters/express': 'src/server-adapters/express.ts',
    'server-adapters/workers': 'src/server-adapters/workers.ts',
    'auth-adapters/better-auth': 'src/auth-adapters/better-auth/adapter.ts',
    server: 'src/server.ts',
    plugin: 'src/plugin/index.ts',
  },
  format: 'esm',
  dts: true,
  clean: true,
  deps: {
    neverBundle: ['@zenstackhq/sdk', '@zenstackhq/language', 'langium', 'express', 'hono', 'zod', 'better-auth', 'agents', 'agents/mcp', '@cloudflare/workers-oauth-provider'],
    onlyBundle: false,
  },
  exports: {
    devExports: 'bun',
    customExports: {
      './plugin.zmodel': './dist/plugin.zmodel',
      './plugin/plugin.zmodel': './dist/plugin.zmodel',
    },
  },
})
