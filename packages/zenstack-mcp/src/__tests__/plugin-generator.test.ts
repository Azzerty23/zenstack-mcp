import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate } from "../plugin/generator.js";

type FakeAttrValue =
  | { $type: "BooleanLiteral"; value: boolean }
  | { $type: "NumberLiteral"; value: string };

function mcpAttr(args: Array<{ name?: string; value: FakeAttrValue }>) {
  return { decl: { $refText: "@@mcp" }, args };
}

function dataModel(name: string, attributes: unknown[] = []) {
  return { $type: "DataModel", name, attributes };
}

async function runGenerate(declarations: unknown[]) {
  const outputDir = mkdtempSync(join(tmpdir(), "zenstack-mcp-gen-"));
  await generate({
    model: { declarations },
    defaultOutputPath: outputDir,
    pluginOptions: {},
  } as never);
  return Bun.file(join(outputDir, "mcp-config.ts")).text();
}

describe("plugin generator — @@mcp attribute parsing", () => {
  test("model without @@mcp is exposed by default without limit", async () => {
    const code = await runGenerate([dataModel("User")]);
    expect(code).toContain(`"User": { exposed: true }`);
  });

  test("@@mcp(false) hides the model", async () => {
    const code = await runGenerate([
      dataModel("Secret", [mcpAttr([{ value: { $type: "BooleanLiteral", value: false } }])]),
    ]);
    expect(code).toContain(`"Secret": { exposed: false }`);
  });

  test("@@mcp(limit: N) emits the limit", async () => {
    const code = await runGenerate([
      dataModel("Post", [mcpAttr([{ name: "limit", value: { $type: "NumberLiteral", value: "100" } }])]),
    ]);
    expect(code).toContain(`"Post": { exposed: true, limit: 100 }`);
  });

  test("@@mcp(true, limit: N) combines expose and limit", async () => {
    const code = await runGenerate([
      dataModel("Log", [
        mcpAttr([
          { value: { $type: "BooleanLiteral", value: true } },
          { name: "limit", value: { $type: "NumberLiteral", value: "50" } },
        ]),
      ]),
    ]);
    expect(code).toContain(`"Log": { exposed: true, limit: 50 }`);
  });

  test("@@mcp(false, limit: N) keeps the model hidden but records the limit", async () => {
    const code = await runGenerate([
      dataModel("Audit", [
        mcpAttr([
          { value: { $type: "BooleanLiteral", value: false } },
          { name: "limit", value: { $type: "NumberLiteral", value: "10" } },
        ]),
      ]),
    ]);
    expect(code).toContain(`"Audit": { exposed: false, limit: 10 }`);
  });
});
