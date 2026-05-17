/**
 * SQLite-backed TokenStore for the built-in OAuth server.
 *
 * Demonstrates how to implement the TokenStore interface for production use.
 * Unlike the default in-memory store, this survives process restarts and works
 * correctly in multi-process deployments sharing the same SQLite file.
 *
 * For true horizontal scaling (multiple machines), replace with a Redis-backed
 * implementation using the same TokenStore interface.
 */
import { Database } from 'bun:sqlite'
import type { TokenStore } from 'zenstack-mcp'

export function createSqliteTokenStore(dbPath: string): TokenStore {
  const db = new Database(dbPath)

  db.run(`
    CREATE TABLE IF NOT EXISTS mcp_auth_codes (
      code TEXT PRIMARY KEY,
      user TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS mcp_refresh_tokens (
      token TEXT PRIMARY KEY,
      user TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `)

  // Purge expired entries on startup so the tables stay lean
  db.run(`DELETE FROM mcp_auth_codes WHERE expires_at < ${Date.now()}`)
  db.run(`DELETE FROM mcp_refresh_tokens WHERE expires_at < ${Date.now()}`)

  return {
    async saveCode(code, user, codeChallenge, expiresAt) {
      db.run(
        'INSERT OR REPLACE INTO mcp_auth_codes (code, user, code_challenge, expires_at) VALUES (?, ?, ?, ?)',
        [code, JSON.stringify(user), codeChallenge, expiresAt],
      )
    },

    async takeCode(code) {
      const row = db
        .query<{ user: string; code_challenge: string; expires_at: number }, [string]>(
          'SELECT user, code_challenge, expires_at FROM mcp_auth_codes WHERE code = ?',
        )
        .get(code)
      if (!row) return null
      db.run('DELETE FROM mcp_auth_codes WHERE code = ?', [code])
      return { user: JSON.parse(row.user), codeChallenge: row.code_challenge, expiresAt: row.expires_at }
    },

    async saveRefreshToken(token, user, expiresAt) {
      db.run(
        'INSERT OR REPLACE INTO mcp_refresh_tokens (token, user, expires_at) VALUES (?, ?, ?)',
        [token, JSON.stringify(user), expiresAt],
      )
    },

    async takeRefreshToken(token) {
      const row = db
        .query<{ user: string; expires_at: number }, [string]>(
          'SELECT user, expires_at FROM mcp_refresh_tokens WHERE token = ?',
        )
        .get(token)
      if (!row) return null
      db.run('DELETE FROM mcp_refresh_tokens WHERE token = ?', [token])
      return { user: JSON.parse(row.user), expiresAt: row.expires_at }
    },

    async revokeRefreshToken(token) {
      db.run('DELETE FROM mcp_refresh_tokens WHERE token = ?', [token])
    },
  }
}
