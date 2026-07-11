import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createQuerySchemaFactory } from "@zenstackhq/orm";
import type {
  McpEnumDef,
  McpModelDef,
  McpProcedureDef,
  McpServerConfig,
  McpTypeDef,
} from "./types.js";
import { ALL_OPERATIONS } from "./types.js";
import { registerSchemaTool } from "./tools/schema-tool.js";
import { registerExecuteTool } from "./tools/execute-tool.js";
import { registerProcedureTool } from "./tools/procedure-tool.js";
import { registerMeTool } from "./tools/me-tool.js";
import type { QuerySchemaFactory } from "./tools/validate.js";
import type { AttributeApplication, SchemaDef } from "@zenstackhq/schema";

type RawAttributes = readonly AttributeApplication[];

type RawFieldDef = {
  type: string;
  id?: boolean;
  unique?: boolean;
  optional?: boolean;
  array?: boolean;
  relation?: object;
  attributes?: RawAttributes;
};

type RawSchemaDef = {
  models: Record<
    string,
    {
      name: string;
      fields: Record<string, RawFieldDef>;
      attributes?: RawAttributes;
    }
  >;
  enums?: Record<
    string,
    {
      name: string;
      values: Record<string, string>;
      attributes?: RawAttributes;
    }
  >;
  typeDefs?: Record<
    string,
    {
      name: string;
      fields: Record<string, RawFieldDef>;
      attributes?: RawAttributes;
    }
  >;
  procedures?: Record<
    string,
    {
      params?: Record<
        string,
        { type: string; array?: boolean; optional?: boolean }
      >;
      returnType: string;
      returnArray?: boolean;
      mutation?: boolean;
    }
  >;
};

/** Maps a raw field def to the structural `McpFieldDef` shared by the schema,
 *  execute and validate tools. Used for both model and type-def fields. */
function toFieldDef(fieldName: string, fieldDef: RawFieldDef) {
  return {
    name: fieldName,
    type: fieldDef.type,
    isId: fieldDef.id ?? false,
    isUnique: fieldDef.unique ?? false,
    isRequired: !(fieldDef.optional ?? false),
    isList: fieldDef.array ?? false,
    isRelation: !!fieldDef.relation,
    ...(fieldDef.attributes ? { attributes: fieldDef.attributes } : {}),
  };
}

/**
 * Reads the `@@map` attribute value from a raw model def (= DB table name).
 * This is NOT used for the ZenStack client accessor — the accessor is always
 * lowerFirst(modelName) because the enhanced-client proxy does a case-insensitive
 * match against schema model names, not @@map values.
 */
function getModelMapName(
  modelDef: RawSchemaDef["models"][string],
): string | undefined {
  const mapAttr = modelDef.attributes?.find((a) => a.name === "@@map");
  if (!mapAttr) return undefined;
  const arg = mapAttr.args?.[0];
  if (arg?.value.kind === "literal" && typeof arg.value.value === "string") {
    return arg.value.value;
  }
  return undefined;
}

function assertRawSchema(schema: unknown): asserts schema is RawSchemaDef {
  if (
    typeof schema !== "object" ||
    schema === null ||
    !("models" in schema) ||
    typeof (schema as Record<string, unknown>).models !== "object"
  ) {
    throw new Error(
      "zenstack-mcp: schema does not have the expected shape. " +
        "Make sure you are passing the generated schema from '~/zenstack/schema'.",
    );
  }
}

export function extractModels<Schema extends SchemaDef>(
  config: McpServerConfig<Schema>,
): McpModelDef[] {
  const raw = config.schema as unknown;
  assertRawSchema(raw);

  const allModels = Object.entries(raw.models).map(([name, modelDef]) => {
    const fields = Object.entries(modelDef.fields).map(([fieldName, fieldDef]) =>
      toFieldDef(fieldName, fieldDef),
    );
    const mapName = getModelMapName(modelDef);
    return {
      name,
      // lowerFirst(name) is the ZenStack client accessor regardless of @@map.
      // @@map changes the DB table name only — stored separately as mapName.
      dbName: name.charAt(0).toLowerCase() + name.slice(1),
      ...(mapName !== undefined ? { mapName } : {}),
      operations: [...ALL_OPERATIONS],
      fields,
      ...(modelDef.attributes ? { attributes: modelDef.attributes } : {}),
    } satisfies McpModelDef;
  });

  let filtered: McpModelDef[];
  if (config.mcpConfig) {
    // Models absent from mcpConfig.models are treated as unexposed (denylist by default).
    // Only models with explicit exposed: true are included.
    filtered = allModels.filter(
      (m) => config.mcpConfig!.models[m.name]?.exposed === true,
    );
  } else if (config.include) {
    filtered = allModels.filter((m) => config.include!.includes(m.name));
  } else if (config.exclude) {
    filtered = allModels.filter((m) => !config.exclude!.includes(m.name));
  } else {
    filtered = allModels;
  }

  // Apply per-model operation restrictions from mcpConfig or modelOperations
  // option, plus the per-model take limit from @@mcp(limit: N).
  return filtered.map((m) => {
    const limit = config.mcpConfig?.models[m.name]?.limit;
    const base = limit !== undefined ? { ...m, limit } : m;
    const fromOption = config.modelOperations?.[m.name];
    if (fromOption) return { ...base, operations: fromOption };
    const fromConfig = config.mcpConfig?.models[m.name]?.operations;
    if (fromConfig) return { ...base, operations: fromConfig };
    return base;
  });
}

/**
 * Reads custom procedures from the generated schema and applies the same
 * exposure filtering as models. When `mcpConfig.procedures` is absent, every
 * declared procedure is exposed; when present, only entries with
 * `exposed: true` are kept (denylist-by-default, mirroring models).
 */
export function extractProcedures<Schema extends SchemaDef>(
  config: McpServerConfig<Schema>,
): McpProcedureDef[] {
  const raw = config.schema as unknown as RawSchemaDef;
  if (!raw.procedures) return [];

  const all = Object.entries(raw.procedures).map(([name, def]) => ({
    name,
    params: Object.entries(def.params ?? {}).map(([paramName, p]) => ({
      name: paramName,
      type: p.type,
      isList: p.array ?? false,
      isRequired: !(p.optional ?? false),
    })),
    returnType: def.returnType,
    returnArray: def.returnArray ?? false,
    mutation: def.mutation ?? false,
  } satisfies McpProcedureDef));

  const procCfg = config.mcpConfig?.procedures;
  if (!procCfg) return all;
  return all.filter((p) => procCfg[p.name]?.exposed === true);
}

/**
 * Reads enum declarations from the generated schema. Enums carry no access
 * policies and are global type definitions referenced by model/type fields, so
 * they are surfaced in full (no exposure filtering) — the `schema` tool needs
 * them to explain the allowed values of enum-typed fields.
 */
export function extractEnums<Schema extends SchemaDef>(
  config: McpServerConfig<Schema>,
): McpEnumDef[] {
  const raw = config.schema as unknown as RawSchemaDef;
  if (!raw.enums) return [];
  return Object.entries(raw.enums).map(([name, def]) => ({
    name,
    values: Object.keys(def.values ?? {}),
    ...(def.attributes ? { attributes: def.attributes } : {}),
  } satisfies McpEnumDef));
}

/**
 * Reads `type` declarations (reusable structural types, e.g. for typed JSON
 * fields) from the generated schema. Like enums, these are global definitions
 * without policies and are surfaced in full.
 */
export function extractTypeDefs<Schema extends SchemaDef>(
  config: McpServerConfig<Schema>,
): McpTypeDef[] {
  const raw = config.schema as unknown as RawSchemaDef;
  if (!raw.typeDefs) return [];
  return Object.entries(raw.typeDefs).map(([name, def]) => ({
    name,
    fields: Object.entries(def.fields ?? {}).map(([fieldName, fieldDef]) =>
      toFieldDef(fieldName, fieldDef),
    ),
    ...(def.attributes ? { attributes: def.attributes } : {}),
  } satisfies McpTypeDef));
}

// The factory caches the zod schemas it builds internally, but buildMcpServer
// runs on every request in the stateless HTTP adapters — memoize per schema
// object so the cache actually survives across requests.
const factoryCache = new WeakMap<object, QuerySchemaFactory>();

function getQuerySchemaFactory(schema: SchemaDef): QuerySchemaFactory {
  let factory = factoryCache.get(schema);
  if (!factory) {
    factory = createQuerySchemaFactory(schema) as unknown as QuerySchemaFactory;
    factoryCache.set(schema, factory);
  }
  return factory;
}

export function buildMcpServer<Schema extends SchemaDef>(
  models: McpModelDef[],
  config: McpServerConfig<Schema>,
): McpServer {
  const factory = getQuerySchemaFactory(config.schema);
  const server = new McpServer({
    name: config.name ?? "zenstack-mcp",
    version: config.version ?? "0.1.0",
  });

  const procedures = extractProcedures(config);
  const enums = extractEnums(config);
  const typeDefs = extractTypeDefs(config);
  const validateOptions = {
    requireWhereForBulk: config.requireWhereForBulk,
    relationDepth: config.relationDepth ?? 2,
    maxTake: config.maxTake,
  };

  registerSchemaTool(server, models, procedures, factory, validateOptions.relationDepth, enums, typeDefs);
  registerMeTool(server);
  registerExecuteTool(server, models, config.getClient, factory, validateOptions);

  if (procedures.length > 0) {
    registerProcedureTool(server, procedures, config.getClient, factory);
  }

  // Host-defined tools (e.g. oRPC-backed), registered last so they can't be
  // shadowed by and don't interfere with the built-in tools above.
  config.registerTools?.(server);

  return server;
}
