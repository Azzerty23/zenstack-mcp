import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { McpModelDef, McpServerConfig, ZenStackClientShape } from "../types.js";
import type { SchemaDef } from "@zenstackhq/schema";
import type { AuthType } from "@zenstackhq/orm";
import { getRequestUser } from "../context.js";
import {
  validateOperation,
  type QuerySchemaFactory,
  type ValidateOptions,
} from "./validate.js";

export function registerExecuteTool<Schema extends SchemaDef>(
  server: McpServer,
  models: McpModelDef[],
  getClient: McpServerConfig<Schema>["getClient"],
  factory: QuerySchemaFactory,
  options: ValidateOptions = {},
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
        "Access policies from the ZenStack schema are enforced automatically. " +
        "Call `schema` with a model and operation to get the exact JSON Schema of `args`.",
      inputSchema: {
        model: z.enum(modelNames).describe("Model name (PascalCase)"),
        operation: z.enum(allOps).describe("Operation name"),
        args: z.record(z.string(), z.unknown()).describe("Operation arguments"),
      },
    },
    async ({ model, operation, args }) => {
      const validation = validateOperation(models, model, operation, args, factory, options);
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
