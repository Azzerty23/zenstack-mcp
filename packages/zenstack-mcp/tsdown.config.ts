import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'index.ts',
    'server-adapters/hono': 'src/server-adapters/hono.ts',
    'server-adapters/express': 'src/server-adapters/express.ts',
    'auth-adapters/better-auth': 'src/auth-adapters/better-auth/adapter.ts',
    server: 'src/server.ts',
    plugin: 'src/plugin/index.ts',
  },
  format: 'esm',
  dts: true,
  clean: true,
  deps: {
    // Use regexes so subpath imports (e.g. `@zenstackhq/language/ast`) are also
    // treated as external. A bare `@zenstackhq/language` string does NOT match
    // the `/ast` subpath — that gap let the langium reflection get inlined and
    // crash against the host's newer langium major (3.x → 4.x).
    neverBundle: [
      /^@zenstackhq\/sdk(\/|$)/,
      /^@zenstackhq\/language(\/|$)/,
      /^langium(\/|$)/,
      'express',
      'hono',
      'zod',
      'better-auth',
    ],
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
