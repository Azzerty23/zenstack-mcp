import { z } from "zod";
import type { McpModelDef, McpOperation } from "../types.js";
import { OPERATION_SCHEMA_METHOD, type QuerySchemaFactory } from "./validate.js";

// ============================================================================
// COMPACT JSON SCHEMA VIA THE FACTORY'S SCHEMA REGISTRY
// ----------------------------------------------------------------------------
// The ORM's ZodSchemaFactory registers every named schema it builds
// (ModelWhereInput, ModelCreateData, StringFilter, …) in a zod registry with
// an `id`. Handing that registry to `z.toJSONSchema`'s `metadata` option makes
// every named schema get extracted ONCE into `$defs` and referenced by `$ref`
// everywhere else, instead of being inlined at every usage site. Inlining
// grows exponentially with relation depth (tens of MB at relationDepth 2 on a
// moderately connected schema); `$refs` keep the document orders of magnitude
// smaller.
// ============================================================================

type MetadataRegistryLike = {
  get(schema: unknown): Record<string, unknown> | undefined;
};

/**
 * Read-only metadata view over the factory registry that disambiguates
 * duplicate ids.
 *
 * With a finite `relationDepth`, relation cycles make the factory build
 * several DISTINCT zod instances of the same conceptual schema (User → posts
 * → author re-enters "UserWhereInput" with less remaining depth), all
 * registered under the same id — which zod's `toJSONSchema` rejects as a
 * duplicate-id error. The first instance seen keeps the bare id; later
 * distinct instances get a stable numeric suffix ("UserWhereInput2", …).
 * Byte-identical survivors are re-merged afterwards by the dedupe pass.
 */
function disambiguatedRegistry(factory: QuerySchemaFactory): MetadataRegistryLike {
  const registry = (factory as { schemaRegistry?: MetadataRegistryLike }).schemaRegistry;
  const idOwners = new Map<string, unknown>();
  const resolved = new WeakMap<object, Record<string, unknown>>();
  return {
    get(target: unknown): Record<string, unknown> | undefined {
      const meta = registry?.get(target);
      if (!meta || typeof meta.id !== "string" || typeof target !== "object" || target === null) {
        return meta;
      }
      const cached = resolved.get(target);
      if (cached) return cached;
      let id = meta.id;
      if (idOwners.get(id) !== undefined && idOwners.get(id) !== target) {
        let suffix = 2;
        while (idOwners.has(`${id}${suffix}`)) suffix++;
        id = `${id}${suffix}`;
      }
      idOwners.set(id, target);
      const result = id === meta.id ? meta : { ...meta, id };
      resolved.set(target, result);
      return result;
    },
  };
}

function rewriteRefs(node: unknown, renames: Map<string, string>): void {
  if (Array.isArray(node)) {
    for (const item of node) rewriteRefs(item, renames);
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  if (typeof obj.$ref === "string") {
    const renamed = renames.get(obj.$ref);
    if (renamed !== undefined) obj.$ref = renamed;
  }
  for (const value of Object.values(obj)) rewriteRefs(value, renames);
}

/**
 * Merge byte-identical `$defs` entries in place (keeping the shortest name)
 * and rewrite all `$ref`s accordingly. Runs to a fixpoint: merging children
 * can make parents identical in turn.
 */
export function dedupeJsonSchemaDefs(root: { $defs?: Record<string, unknown> }): void {
  for (;;) {
    const defs = root.$defs;
    if (!defs) return;

    const byContent = new Map<string, string[]>();
    for (const [name, body] of Object.entries(defs)) {
      const key = JSON.stringify(body);
      const group = byContent.get(key);
      if (group) group.push(name);
      else byContent.set(key, [name]);
    }

    const renames = new Map<string, string>();
    for (const group of byContent.values()) {
      if (group.length < 2) continue;
      // Keep the shortest name (then lexicographic) — "UserWhereInput" over
      // "UserWhereInput2".
      const canonical = [...group].sort(
        (a, b) => a.length - b.length || a.localeCompare(b),
      )[0] as string;
      for (const name of group) {
        if (name === canonical) continue;
        renames.set(`#/$defs/${name}`, `#/$defs/${canonical}`);
        delete defs[name];
      }
    }

    if (renames.size === 0) return;
    rewriteRefs(root, renames);
  }
}

/**
 * Convert a factory-built zod schema to JSON Schema with named schemas
 * extracted into deduplicated `$defs` instead of inlined at every usage.
 */
export function toCompactJSONSchema(
  schema: unknown,
  factory: QuerySchemaFactory,
): Record<string, unknown> {
  // `unrepresentable: 'any'` maps JSON-Schema-less types (Date, custom
  // scalars like Decimal/Bytes) to `{}` instead of throwing.
  const jsonSchema = z.toJSONSchema(schema as z.ZodType, {
    io: "input",
    unrepresentable: "any",
    metadata: disambiguatedRegistry(factory) as never,
  }) as Record<string, unknown>;
  dedupeJsonSchemaDefs(jsonSchema);
  return jsonSchema;
}

// ============================================================================
// PROGRESSIVE DISCLOSURE
// ----------------------------------------------------------------------------
// A full operation document at unlimited relation depth is finite (recursion
// becomes `$ref` cycles) but its `$defs` closure is large — hundreds of KB on
// a moderately connected schema, ~99% of the document. Instead of returning
// it whole on every call, the schema tool returns the small root plus as many
// definitions as fit a byte budget, and lists the rest as pending: the client
// fetches each named definition once, on demand, amortizing the closure over
// the conversation the way an OpenAPI spec amortizes `components.schemas`
// over the whole document.
// ============================================================================

/** Byte budget for `$defs` included alongside a root or component schema. */
const DEF_BUDGET_BYTES = 32 * 1024;

const ANON_DEF_RE = /^__schema\d+$/;

type JsonSchemaDoc = Record<string, unknown> & {
  $defs?: Record<string, unknown>;
};

function collectRefNames(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefNames(item, into);
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  if (typeof obj.$ref === "string" && obj.$ref.startsWith("#/$defs/")) {
    into.add(obj.$ref.slice("#/$defs/".length));
  }
  for (const value of Object.values(obj)) collectRefNames(value, into);
}

/**
 * Rename anonymous `__schemaN` defs (cyclic schemas zod extracts that carry
 * no registry id) to document-scoped names (`Anon_<scope><n>`).
 *
 * zod numbers anonymous defs by traversal order, so `__schema3` means a
 * different thing in every generated document — while the catalog serves
 * definitions across documents by name. Scoping the name to the document
 * (e.g. `Anon_UserUpdate3`) makes it unique in the catalog and deterministic
 * (the document itself is deterministic for a given model+operation+depth).
 * The same underlying structure may get one name per originating document;
 * that only costs an occasional duplicate `component` fetch.
 */
export function stabilizeAnonymousDefs(doc: JsonSchemaDoc, scope: string): void {
  const defs = doc.$defs;
  if (!defs) return;
  const anonNames = Object.keys(defs)
    .filter((n) => ANON_DEF_RE.test(n))
    .sort((a, b) => Number(a.slice("__schema".length)) - Number(b.slice("__schema".length)));
  if (anonNames.length === 0) return;

  const renames = new Map<string, string>();
  anonNames.forEach((name, i) => {
    const target = `Anon_${scope}${i + 1}`;
    if (defs[target] !== undefined) return; // never clobber an existing def
    renames.set(`#/$defs/${name}`, `#/$defs/${target}`);
    defs[target] = defs[name];
    delete defs[name];
  });
  if (renames.size > 0) rewriteRefs(doc, renames);
}

// Documents and the definition catalog are memoized per factory (which
// `buildMcpServer` already memoizes per schema object), so the expensive
// unlimited-depth generation runs once per (model, operation) per isolate and
// `component` lookups can serve definitions discovered by any earlier call.
// Both are keyed by the validation depth in case servers with different
// `relationDepth` configs share a factory.
const documentCache = new WeakMap<object, Map<string, JsonSchemaDoc>>();
const catalogCache = new WeakMap<object, Map<string, Map<string, unknown>>>();

function getCatalog(factory: QuerySchemaFactory, relationDepth?: number): Map<string, unknown> {
  let byDepth = catalogCache.get(factory);
  if (!byDepth) catalogCache.set(factory, (byDepth = new Map()));
  const key = String(relationDepth ?? "unlimited");
  let catalog = byDepth.get(key);
  if (!catalog) byDepth.set(key, (catalog = new Map()));
  return catalog;
}

/**
 * Build (memoized) the full compact document for one model+operation at the
 * given relation depth (undefined = unlimited, truly recursive), with
 * stabilized definition names, and feed its `$defs` into the catalog.
 */
export function getOperationDocument(
  factory: QuerySchemaFactory,
  method: (typeof OPERATION_SCHEMA_METHOD)[McpOperation],
  model: string,
  relationDepth?: number,
): JsonSchemaDoc {
  let byKey = documentCache.get(factory);
  if (!byKey) documentCache.set(factory, (byKey = new Map()));
  const key = `${relationDepth ?? "unlimited"}|${model}|${method}`;
  const cached = byKey.get(key);
  if (cached) return cached;

  const schema = factory[method](
    model,
    relationDepth !== undefined ? { relationDepth } : undefined,
  );
  const doc = toCompactJSONSchema(schema, factory) as JsonSchemaDoc;
  const scope = `${model}${method.replace(/^make/, "").replace(/Schema$/, "")}`;
  stabilizeAnonymousDefs(doc, scope);
  byKey.set(key, doc);

  const catalog = getCatalog(factory, relationDepth);
  for (const [name, body] of Object.entries(doc.$defs ?? {})) {
    if (!catalog.has(name)) catalog.set(name, body);
  }
  return doc;
}

export type SlicedDocument = {
  schema: JsonSchemaDoc;
  /** Definitions referenced by the returned schema but not included in it. */
  pending: string[];
};

/**
 * Return the document's root with only as many `$defs` as fit the byte
 * budget, breadth-first from the root: directly-referenced definitions are
 * always included; deeper hops are added smallest-first while the budget
 * lasts. Whatever stays out but is still referenced is listed as `pending`.
 */
export function sliceDocument(
  doc: JsonSchemaDoc,
  budget = DEF_BUDGET_BYTES,
): SlicedDocument {
  const defs = doc.$defs ?? {};
  const { $defs: _omit, ...root } = doc;

  const included: Record<string, unknown> = {};
  const seen = new Set<string>();
  let used = 0;

  const rootRefs = new Set<string>();
  collectRefNames(root, rootRefs);
  let frontier = [...rootRefs].filter((n) => n in defs).sort();
  for (const name of frontier) seen.add(name);

  let firstHop = true;
  while (frontier.length > 0) {
    const sized = frontier
      .map((name) => [name, JSON.stringify(defs[name]).length] as const)
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
    const next: string[] = [];
    for (const [name, size] of sized) {
      if (!firstHop && used + size > budget) continue;
      included[name] = defs[name];
      used += size;
      const refs = new Set<string>();
      collectRefNames(defs[name], refs);
      for (const ref of refs) {
        if (ref in defs && !seen.has(ref)) {
          seen.add(ref);
          next.push(ref);
        }
      }
    }
    frontier = next;
    firstHop = false;
  }

  const mentioned = new Set<string>();
  collectRefNames(root, mentioned);
  collectRefNames(included, mentioned);
  const pending = [...mentioned]
    .filter((name) => !(name in included) && name in defs)
    .sort();

  const schema: JsonSchemaDoc =
    Object.keys(included).length > 0 ? { ...root, $defs: included } : root;
  return { schema, pending };
}

/**
 * Serve one named definition from the catalog as a standalone document
 * (`$ref` root + budgeted `$defs`), generating operation documents on demand
 * until the name is found. Returns undefined if the name matches nothing
 * after a full sweep of the exposed models and operations.
 */
export function getComponentDocument(
  factory: QuerySchemaFactory,
  models: McpModelDef[],
  name: string,
  relationDepth?: number,
): SlicedDocument | undefined {
  const catalog = getCatalog(factory, relationDepth);
  if (!catalog.has(name)) {
    // Most definition names start with the model they belong to
    // ("PostWhereInput") — sweep those models first, longest match first,
    // since each document generation is expensive.
    const ordered = [...models].sort((a, b) => {
      const score = (m: McpModelDef) => (name.startsWith(m.name) ? m.name.length : 0);
      return score(b) - score(a);
    });
    sweep: for (const model of ordered) {
      const methods = new Set(
        model.operations.map((op) => OPERATION_SCHEMA_METHOD[op]),
      );
      for (const method of methods) {
        try {
          getOperationDocument(factory, method, model.name, relationDepth);
        } catch {
          // Some operations cannot build a schema (e.g. no unique fields) —
          // skip them; the definition may come from another document.
        }
        if (catalog.has(name)) break sweep;
      }
    }
  }
  if (!catalog.has(name)) return undefined;
  return sliceDocument({
    $ref: `#/$defs/${name}`,
    $defs: Object.fromEntries(catalog),
  });
}

/** Sorted sample of known definition names, for unknown-component errors. */
export function knownDefinitions(
  factory: QuerySchemaFactory,
  relationDepth?: number,
  limit = 40,
): string[] {
  return [...getCatalog(factory, relationDepth).keys()].sort().slice(0, limit);
}
