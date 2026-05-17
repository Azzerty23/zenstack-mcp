import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { McpModelDef, McpServerOptions, ZenStackClientShape } from "../types.js";
import type { SchemaDef } from "@zenstackhq/schema";
import type { AuthType } from "@zenstackhq/orm";
import { getRequestUser } from "../context.js";
import { validateOperation, type ZodFactory } from "./validate.js";

export function registerExecuteTool<Schema extends SchemaDef>(
  server: McpServer,
  models: McpModelDef[],
  getClient: McpServerOptions<Schema>["getClient"],
  zodFactory?: ZodFactory,
  requireWhereForBulk?: boolean,
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
        const client = await getClient(getRequestUser() as AuthType<Schema>) as ZenStackClientShape;
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
