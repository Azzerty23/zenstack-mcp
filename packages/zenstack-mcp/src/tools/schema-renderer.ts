import type { McpFieldDef, McpModelDef, McpProcedureDef } from '../types.js'
import { ALL_OPERATIONS } from '../types.js'

/**
 * Renders the exposed schema as concise ZModel/Prisma-style text instead of
 * verbose JSON. LLMs parse this DSL natively (it matches their Prisma training
 * data) and it costs a fraction of the tokens of the structured `McpModelDef`
 * form — booleans collapse into `@id` / `?` / `[]` modifiers and the shared
 * operation list is stated once rather than repeated per model.
 *
 * This renders the *already-filtered* models/procedures, so the exposure
 * boundary (mcpConfig / include / exclude) is preserved — it never reflects the
 * raw `schema.zmodel`, which also carries access policies and hidden models.
 */

function renderField(f: McpFieldDef): string {
  const suffix = f.isList ? '[]' : f.isRequired ? '' : '?'
  let attrs = ''
  if (f.isId) attrs += ' @id'
  else if (f.isUnique) attrs += ' @unique'
  return `  ${f.name} ${f.type}${suffix}${attrs}`
}

function isFullOperationSet(operations: string[]): boolean {
  return (
    operations.length === ALL_OPERATIONS.length &&
    ALL_OPERATIONS.every((op) => operations.includes(op))
  )
}

function renderModel(m: McpModelDef): string {
  const lines = m.fields.map(renderField)
  // Only note operations when they diverge from the default (full) set —
  // otherwise the default declared in the header applies.
  if (!isFullOperationSet(m.operations)) {
    lines.push(`  // operations: ${m.operations.join(', ')}`)
  }
  return `model ${m.name} {\n${lines.join('\n')}\n}`
}

function renderProcedure(p: McpProcedureDef): string {
  const params = p.params
    .map((a) => `${a.name}: ${a.type}${a.isList ? '[]' : ''}${a.isRequired ? '' : '?'}`)
    .join(', ')
  const prefix = p.mutation ? 'mutation procedure' : 'procedure'
  return `${prefix} ${p.name}(${params}): ${p.returnType}${p.returnArray ? '[]' : ''}`
}

/**
 * Produces the ZModel-style document returned by the `schema` tool: the model
 * blocks (queried via `execute`) followed by any custom procedures (invoked via
 * `procedure`). The default operation set is declared once in the header.
 */
export function renderSchema(
  models: McpModelDef[],
  procedures: McpProcedureDef[],
): string {
  const sections: string[] = []

  sections.push(
    `// Models below are queried via the \`execute\` tool.\n` +
      `// Default operations (unless a model notes otherwise): ${ALL_OPERATIONS.join(', ')}.`,
  )

  sections.push(
    models.length
      ? models.map(renderModel).join('\n\n')
      : '// (no models exposed)',
  )

  if (procedures.length) {
    sections.push(
      `// Custom procedures, invoked via the \`procedure\` tool:\n` +
        procedures.map(renderProcedure).join('\n'),
    )
  }

  return sections.join('\n\n')
}
