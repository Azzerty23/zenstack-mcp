import { loginScript } from './oauth/login-script.js'
import { loginHtml } from './oauth/login-html.js'

export { loginScript }

export function loginPage(): string {
  return loginHtml
}

export function injectLoginScript(html: string, options?: { nonce?: string }): string {
  // Case-insensitive regex handles </BODY> produced by some HTML generators.
  // String.replace() with a plain string pattern returns the input unchanged when the
  // pattern is absent — throwing here makes misconfigured custom login pages fail loudly
  // instead of silently serving a broken form.
  const nonceAttr = options?.nonce ? ` nonce="${options.nonce}"` : ''
  const scriptTag = `<script${nonceAttr}>${loginScript}</script>`
  const result = html.replace(/<\/body>/i, `${scriptTag}</body>`)
  if (result === html) {
    throw new Error('zenstack-mcp: injectLoginScript could not find </body> in the provided HTML.')
  }
  return result
}
