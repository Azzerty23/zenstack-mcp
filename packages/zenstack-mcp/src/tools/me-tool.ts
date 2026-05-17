import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getRequestUser } from '../context.js'

export function registerMeTool(server: McpServer): void {
  server.registerTool('me', {
    description: 'Returns the authenticated user for the current request.',
    inputSchema: {},
  }, async () => {
    const user = getRequestUser()
    return {
      content: [{ type: 'text', text: JSON.stringify({ user: user ?? null }) }],
    }
  })
}
