import type { CliPlugin, CliGeneratorContext } from '@zenstackhq/sdk'
import { generate } from './generator.js'

const plugin: CliPlugin = {
  name: 'zenstack-mcp',
  statusText: 'Generating MCP config',
  generate: (context: CliGeneratorContext) => generate(context),
}

export default plugin
