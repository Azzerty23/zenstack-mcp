import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type {
  McpModelDef,
  McpServerConfig,
  ModelMutationEvent,
  MutationPublisher,
  ZenStackClientShape,
} from "../types.js";
import type { SchemaDef } from "@zenstackhq/schema";
import type { AuthType } from "@zenstackhq/orm";
import { getRequestUser } from "../context.js";
import { defaultChannel } from "../events/publisher.js";
import { validateOperation, type ZodFactory } from "./validate.js";

/** Maps each write operation to the mutation kind broadcast to subscribers. */
const WRITE_OP_KIND: Record<string, "create" | "update" | "delete"> = {
  create: "create",
  createMany: "create",
  update: "update",
  updateMany: "update",
  upsert: "update",
  delete: "delete",
  deleteMany: "delete",
};

function extractIds(
  idField: string,
  args: Record<string, unknown>,
  result: unknown,
): (string | number)[] | undefined {
  // Single-record results (create/update/upsert/delete) carry the id directly.
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const v = (result as Record<string, unknown>)[idField];
    if (typeof v === "string" || typeof v === "number") return [v];
  }
  // Fall back to a where clause targeting the id (e.g. delete/update by id).
  const where = args.where;
  if (where && typeof where === "object") {
    const v = (where as Record<string, unknown>)[idField];
    if (typeof v === "string" || typeof v === "number") return [v];
  }
  return undefined;
}

/** Builds a mutation event for a write operation; returns null for reads. */
function toMutationEvent(
  modelDef: McpModelDef,
  operation: string,
  args: Record<string, unknown>,
  result: unknown,
): ModelMutationEvent | null {
  const kind = WRITE_OP_KIND[operation];
  if (!kind) return null;

  const idField = modelDef.fields.find((f) => f.isId)?.name ?? "id";
  // Bulk ops return `{ count }`, not a record — there is no per-record data.
  const isBulk = operation.endsWith("Many");
  const ids = extractIds(idField, args, result);

  return {
    operation: kind,
    modelName: modelDef.name,
    ...(!isBulk && result !== null && result !== undefined
      ? { data: result }
      : {}),
    ...(ids ? { ids } : {}),
    timestamp: Date.now(),
  };
}

export function registerExecuteTool<Schema extends SchemaDef>(
  server: McpServer,
  models: McpModelDef[],
  getClient: McpServerConfig<Schema>["getClient"],
  zodFactory: ZodFactory,
  requireWhereForBulk?: boolean,
  publisher?: MutationPublisher,
  channelFormatter?: (modelName: string) => string,
): void {
  const modelNames = models.map((m) => m.name) as [string, ...string[]];
  const allOps = [
    ...new Set(models.flatMap((m) => m.operations)),
  ] as [string, ...string[]];

  server.registerTool(
    "execute",
    {
      description:
        "Executes a database operation on the ZenStack-enhanced client. " +
        "Access policies from the ZenStack schema are enforced automatically.",
      inputSchema: {
        model: z.enum(modelNames).describe("Model name (PascalCase)"),
        operation: z.enum(allOps).describe("Operation name"),
        args: z.record(z.string(), z.unknown()).describe("Operation arguments"),
      },
    },
    async ({ model, operation, args }) => {
      const validation = validateOperation(models, model, operation, args, zodFactory, requireWhereForBulk);
      if (!validation.valid) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ success: false, errors: validation.errors }),
            },
          ],
          isError: true,
        };
      }

      const modelDef = models.find((m) => m.name === model)!;

      try {
        const resolvedUser = getRequestUser() as AuthType<Schema>;
        const client = await getClient(resolvedUser) as ZenStackClientShape;
        const modelClient = client[modelDef.dbName];
        if (!modelClient) {
          throw new Error(`Client does not expose model "${model}"`);
        }
        const op = modelClient[operation];
        if (!op) {
          throw new Error(`Client does not expose operation "${operation}" on "${model}"`);
        }
        const result = await op(args);

        if (publisher) {
          const mutation = toMutationEvent(modelDef, operation, args, result);
          if (mutation) {
            const channel = (channelFormatter ?? defaultChannel)(modelDef.name);
            // Await so the publish completes before we return — serverless
            // runtimes may cut post-response async work. A publish failure must
            // not fail the write, so swallow it.
            await publisher.publish(channel, mutation).catch(() => {});
          }
        }

        return {
          content: [
            { type: "text", text: JSON.stringify({ success: true, result }) },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ success: false, error: message }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
