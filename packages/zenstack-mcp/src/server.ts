import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSchemaFactory } from "@zenstackhq/zod";
import type { McpModelDef, McpServerConfig } from "./types.js";
import { ALL_OPERATIONS } from "./types.js";
import { registerSchemaTool } from "./tools/schema-tool.js";
import { registerExecuteTool } from "./tools/execute-tool.js";
import { registerMeTool } from "./tools/me-tool.js";
import type { SchemaDef } from "@zenstackhq/schema";

type RawAttributeArg = {
  name?: string;
  value: { kind: string; value?: string | number | boolean };
};

type RawSchemaDef = {
  models: Record<
    string,
    {
      name: string;
      fields: Record<
        string,
        {
          type: string;
          id?: boolean;
          unique?: boolean;
          optional?: boolean;
          array?: boolean;
          relation?: object;
        }
      >;
      attributes?: ReadonlyArray<{
        name: string;
        args?: ReadonlyArray<RawAttributeArg>;
      }>;
    }
  >;
};

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
    const fields = Object.entries(modelDef.fields).map(
      ([fieldName, fieldDef]) => ({
        name: fieldName,
        type: fieldDef.type,
        isId: fieldDef.id ?? false,
        isUnique: fieldDef.unique ?? false,
        isRequired: !(fieldDef.optional ?? false),
        isList: fieldDef.array ?? false,
        isRelation: !!fieldDef.relation,
      }),
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

  // Apply per-model operation restrictions from mcpConfig or modelOperations option
  return filtered.map((m) => {
    const fromOption = config.modelOperations?.[m.name];
    if (fromOption) return { ...m, operations: fromOption };
    const fromConfig = config.mcpConfig?.models[m.name]?.operations;
    if (fromConfig) return { ...m, operations: fromConfig };
    return m;
  });
}

export function buildMcpServer<Schema extends SchemaDef>(
  models: McpModelDef[],
  config: McpServerConfig<Schema>,
): McpServer {
  const factory = createSchemaFactory(config.schema);
  const server = new McpServer({
    name: config.name ?? "zenstack-mcp",
    version: config.version ?? "0.1.0",
  });

  registerSchemaTool(server, models);
  registerMeTool(server);
  registerExecuteTool(
    server,
    models,
    config.getClient,
    factory as Parameters<typeof registerExecuteTool>[3],
    config.requireWhereForBulk,
    config.publisher,
    config.channelFormatter,
  );

  return server;
}
