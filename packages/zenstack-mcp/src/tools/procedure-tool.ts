import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { McpProcedureDef, McpServerConfig } from "../types.js";
import type { SchemaDef } from "@zenstackhq/schema";
import type { AuthType } from "@zenstackhq/orm";
import { getRequestUser } from "../context.js";
import type { QuerySchemaFactory } from "./validate.js";

/** Minimal structural view of a ZenStack client's `$procs` surface. */
type ProcClient = {
  $procs?: Record<
    string,
    (input?: { args?: Record<string, unknown> }) => Promise<unknown>
  >;
};

function signature(p: McpProcedureDef): string {
  const params = p.params
    .map((a) => `${a.name}${a.isRequired ? "" : "?"}: ${a.type}${a.isList ? "[]" : ""}`)
    .join(", ");
  return `${p.mutation ? "mutation " : ""}${p.name}(${params}): ${p.returnType}${p.returnArray ? "[]" : ""}`;
}

/**
 * Registers the `procedure` tool, which invokes a custom ZenStack procedure via
 * the enhanced client's `$procs` surface. Like the `execute` tool, it resolves
 * the per-request policy-scoped client through `getClient`, so the procedure
 * runs under the caller's access policies and plugins.
 */
export function registerProcedureTool<Schema extends SchemaDef>(
  server: McpServer,
  procedures: McpProcedureDef[],
  getClient: McpServerConfig<Schema>["getClient"],
  factory: QuerySchemaFactory,
): void {
  const names = procedures.map((p) => p.name) as [string, ...string[]];
  const catalog = procedures.map(signature).join("\n");

  server.registerTool(
    "procedure",
    {
      description:
        "Invokes a custom ZenStack procedure ($procs) on the enhanced client. " +
        "Access policies and plugins are enforced automatically. " +
        "Available procedures:\n" +
        catalog,
      inputSchema: {
        name: z.enum(names).describe("Procedure name (camelCase)"),
        args: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Procedure arguments object (keyed by parameter name)"),
      },
    },
    async ({ name, args }) => {
      const def = procedures.find((p) => p.name === name);
      if (!def) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: `Unknown procedure "${name}"`,
              }),
            },
          ],
          isError: true,
        };
      }

      // Validate args against the ORM's own procedure schema (types, required
      // params, unknown keys).
      const errors: string[] = [];
      try {
        const result = factory.makeProcedureArgsSchema(name).safeParse(args ?? {});
        if (!result.success && result.error) {
          errors.push(
            ...result.error.issues.map((i) =>
              i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message,
            ),
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`Cannot validate procedure "${name}": ${message}`);
      }
      if (errors.length) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ success: false, errors }),
            },
          ],
          isError: true,
        };
      }

      try {
        const resolvedUser = getRequestUser() as AuthType<Schema>;
        const client = (await getClient(resolvedUser)) as ProcClient;
        const proc = client.$procs?.[name];
        if (!proc) {
          throw new Error(`Client does not expose procedure "${name}"`);
        }
        const result = await proc({ args: args ?? {} });
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
