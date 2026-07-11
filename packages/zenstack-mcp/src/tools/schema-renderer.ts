import type { AttributeApplication, Expression } from '@zenstackhq/schema'
import type {
  McpEnumDef,
  McpFieldDef,
  McpModelDef,
  McpProcedureDef,
  McpTypeDef,
} from '../types.js'
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
 * Enums and `type` declarations are surfaced in full (they carry no policies).
 *
 * Every ZModel attribute is rendered verbatim *except* access-policy rules
 * (`@@allow`/`@@deny`/`@allow`/`@deny`), which are stripped so the exposed
 * schema never leaks the server's authorization logic.
 */

/** Access-policy attributes stripped from the rendered schema. */
const POLICY_ATTRIBUTES = new Set(['@allow', '@deny', '@@allow', '@@deny'])

/** Renders a ZModel expression (attribute arg value) back to source-like text. */
function renderExpression(expr: Expression): string {
  switch (expr.kind) {
    case 'literal':
      return typeof expr.value === 'string' ? JSON.stringify(expr.value) : String(expr.value)
    case 'array':
      return `[${expr.items.map(renderExpression).join(', ')}]`
    case 'field':
      return expr.field
    case 'member':
      return [renderExpression(expr.receiver), ...expr.members].join('.')
    case 'binding':
      return expr.name
    case 'call':
      return `${expr.function}(${(expr.args ?? []).map(renderExpression).join(', ')})`
    case 'unary':
      return `${expr.op}${renderExpression(expr.operand)}`
    case 'binary':
      return `${renderExpression(expr.left)} ${expr.op} ${renderExpression(expr.right)}`
    case 'this':
      return 'this'
    case 'null':
      return 'null'
    default:
      return ''
  }
}

/**
 * Renders a single attribute application (e.g. `@default(cuid())`,
 * `@relation(fields: [authorId], references: [id])`). A lone argument is
 * rendered positionally (`@map("posts")`); multiple arguments keep their names
 * (`@relation(fields: …, references: …)`), matching idiomatic ZModel.
 */
function renderAttribute(attr: AttributeApplication): string {
  const args = attr.args ?? []
  if (args.length === 0) return attr.name
  const single = args.length === 1
  const rendered = args.map((a) => {
    const value = renderExpression(a.value)
    return single || !a.name ? value : `${a.name}: ${value}`
  })
  return `${attr.name}(${rendered.join(', ')})`
}

/** Filters out access-policy attributes and renders the rest, space-joined. */
function renderAttributes(attributes: readonly AttributeApplication[] | undefined): string[] {
  if (!attributes) return []
  return attributes.filter((a) => !POLICY_ATTRIBUTES.has(a.name)).map(renderAttribute)
}

function renderField(f: McpFieldDef): string {
  const suffix = f.isList ? '[]' : f.isRequired ? '' : '?'
  let attrs: string
  if (f.attributes) {
    // Real generated schemas carry the full attribute list — render it verbatim.
    const rendered = renderAttributes(f.attributes)
    attrs = rendered.length ? ` ${rendered.join(' ')}` : ''
  } else {
    // Fallback for defs built without attributes: derive the primary markers.
    attrs = f.isId ? ' @id' : f.isUnique ? ' @unique' : ''
  }
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
  // Model-level attributes (`@@map`, `@@index`, `@@unique`, `@@mcp`, …), minus policy rules.
  for (const attr of renderAttributes(m.attributes)) {
    lines.push(`  ${attr}`)
  }
  // Only note operations when they diverge from the default (full) set —
  // otherwise the default declared in the header applies.
  if (!isFullOperationSet(m.operations)) {
    lines.push(`  // operations: ${m.operations.join(', ')}`)
  }
  return `model ${m.name} {\n${lines.join('\n')}\n}`
}

function renderTypeDef(t: McpTypeDef): string {
  const lines = t.fields.map(renderField)
  for (const attr of renderAttributes(t.attributes)) {
    lines.push(`  ${attr}`)
  }
  return `type ${t.name} {\n${lines.join('\n')}\n}`
}

function renderEnum(e: McpEnumDef): string {
  const lines = e.values.map((v) => `  ${v}`)
  for (const attr of renderAttributes(e.attributes)) {
    lines.push(`  ${attr}`)
  }
  return `enum ${e.name} {\n${lines.join('\n')}\n}`
}

function renderProcedure(p: McpProcedureDef): string {
  const params = p.params
    .map((a) => `${a.name}: ${a.type}${a.isList ? '[]' : ''}${a.isRequired ? '' : '?'}`)
    .join(', ')
  const prefix = p.mutation ? 'mutation procedure' : 'procedure'
  return `${prefix} ${p.name}(${params}): ${p.returnType}${p.returnArray ? '[]' : ''}`
}

/**
 * Produces the ZModel-style document returned by the `schema` tool: enums and
 * `type` declarations, then the model blocks (queried via `execute`), then any
 * custom procedures (invoked via `procedure`). The default operation set is
 * declared once in the header.
 */
export function renderSchema(
  models: McpModelDef[],
  procedures: McpProcedureDef[],
  enums: McpEnumDef[] = [],
  typeDefs: McpTypeDef[] = [],
): string {
  const sections: string[] = []

  sections.push(
    `// Models below are queried via the \`execute\` tool.\n` +
      `// Default operations (unless a model notes otherwise): ${ALL_OPERATIONS.join(', ')}.`,
  )

  if (enums.length) {
    sections.push(enums.map(renderEnum).join('\n\n'))
  }

  if (typeDefs.length) {
    sections.push(typeDefs.map(renderTypeDef).join('\n\n'))
  }

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
