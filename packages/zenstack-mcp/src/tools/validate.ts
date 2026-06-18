import { z } from "zod";
import type { McpModelDef, McpOperation } from "../types.js";
import {
  buildWhereSchema,
  buildWhereUniqueSchema,
  buildOrderBySchema,
} from "./schema-generator.js";

const anyObj = z.record(z.string(), z.unknown());
const dataObj = z.record(z.string(), z.unknown());

const ARG_STRUCT_SCHEMAS: Partial<Record<McpOperation, z.ZodTypeAny>> = {
  findUnique: z.looseObject({ where: anyObj }),
  findUniqueOrThrow: z.looseObject({ where: anyObj }),
  findFirst: z.looseObject({ where: anyObj.optional() }),
  findFirstOrThrow: z.looseObject({ where: anyObj.optional() }),
  findMany: z.looseObject({
    where: anyObj.optional(),
    skip: z.number().int().nonnegative().optional(),
    take: z.number().int().optional(),
    cursor: anyObj.optional(),
  }),
  create: z.looseObject({ data: dataObj }),
  createMany: z.looseObject({ data: z.array(dataObj) }),
  createManyAndReturn: z.looseObject({ data: z.array(dataObj) }),
  update: z.looseObject({ where: anyObj, data: dataObj }),
  updateMany: z.looseObject({ where: anyObj.optional(), data: dataObj }),
  updateManyAndReturn: z.looseObject({ where: anyObj.optional(), data: dataObj }),
  upsert: z.looseObject({ where: anyObj, create: dataObj, update: dataObj }),
  delete: z.looseObject({ where: anyObj }),
  deleteMany: z.looseObject({ where: anyObj.optional() }),
  count: z.looseObject({ where: anyObj.optional() }),
  exists: z.looseObject({ where: anyObj.optional() }),
  // Analytical ops carry a different arg shape (_count/_sum/_avg/having, etc.);
  // we structurally validate only the part we model (where/by) and pass the rest through.
  aggregate: z.looseObject({ where: anyObj.optional() }),
  groupBy: z.looseObject({ by: z.union([z.string(), z.array(z.string())]) }),
};

type ZodIssue = { message: string; path: Array<string | number> };

type ModelSchema = {
  safeParse: (v: unknown) => {
    success: boolean;
    error?: { issues: ZodIssue[] };
  };
};

function formatIssues(issues: ZodIssue[], prefix?: string): string[] {
  return issues.map((i) => {
    const path = i.path.length > 0 ? i.path.join(".") : undefined;
    const location = [prefix, path].filter(Boolean).join(".");
    return location ? `${location}: ${i.message}` : i.message;
  });
}

function validateData(
  schema: ModelSchema,
  data: unknown,
  prefix: string,
  errors: string[],
): void {
  const result = schema.safeParse(data);
  if (!result.success && result.error) {
    errors.push(...formatIssues(result.error.issues as ZodIssue[], prefix));
  }
}

export type ZodFactory = {
  makeModelSchema: (
    model: string,
    opts?: { optionality: string },
  ) => ModelSchema;
};

export type ValidationResult =
  | { valid: true }
  | { valid: false; errors: string[] };

export function validateOperation(
  models: McpModelDef[],
  model: string,
  operation: string,
  args: Record<string, unknown>,
  zodFactory: ZodFactory,
  requireWhereForBulk?: boolean,
): ValidationResult {
  const errors: string[] = [];

  const modelDef = models.find((m) => m.name === model);
  if (!modelDef) {
    return {
      valid: false,
      errors: [
        `Unknown model "${model}". Available: ${models.map((m) => m.name).join(", ")}`,
      ],
    };
  }

  if (!modelDef.operations.includes(operation as McpOperation)) {
    return {
      valid: false,
      errors: [
        `Operation "${operation}" not available on "${model}". Available: ${modelDef.operations.join(", ")}`,
      ],
    };
  }

  if (
    requireWhereForBulk &&
    (operation === "deleteMany" ||
      operation === "updateMany" ||
      operation === "updateManyAndReturn")
  ) {
    const where = args.where;
    const isEmpty =
      !where ||
      (typeof where === "object" &&
        !Array.isArray(where) &&
        Object.keys(where as object).length === 0);
    if (isEmpty) {
      errors.push(
        `"where" must not be absent or empty for "${operation}" — set requireWhereForBulk: false to allow bulk operations without a filter`,
      );
    }
  }

  // Structural shape validation (correct keys, primitive types)
  const structSchema = ARG_STRUCT_SCHEMAS[operation as McpOperation];
  if (structSchema) {
    const structResult = structSchema.safeParse(args);
    if (!structResult.success) {
      errors.push(...formatIssues(structResult.error.issues as ZodIssue[]));
    }
  }

  const { fields } = modelDef;

  // Field-level where validation
  switch (operation as McpOperation) {
    case "findUnique":
    case "findUniqueOrThrow":
    case "update":
    case "upsert":
    case "delete":
      if ("where" in args && args.where !== undefined) {
        validateData(
          buildWhereUniqueSchema(model, fields) as ModelSchema,
          args.where,
          "where",
          errors,
        );
      }
      break;
    case "findFirst":
    case "findFirstOrThrow":
    case "findMany":
    case "updateMany":
    case "updateManyAndReturn":
    case "deleteMany":
    case "count":
    case "exists":
    case "aggregate":
    case "groupBy":
      if ("where" in args && args.where !== undefined) {
        validateData(
          buildWhereSchema(model, fields) as ModelSchema,
          args.where,
          "where",
          errors,
        );
      }
      break;
  }

  // Field-level orderBy validation (read + analytical ops that accept ordering)
  const ORDER_BY_OPS: McpOperation[] = [
    "findFirst",
    "findFirstOrThrow",
    "findMany",
    "aggregate",
    "groupBy",
  ];
  if (
    ORDER_BY_OPS.includes(operation as McpOperation) &&
    "orderBy" in args &&
    args.orderBy !== undefined
  ) {
    validateData(
      buildOrderBySchema(model, fields) as ModelSchema,
      args.orderBy,
      "orderBy",
      errors,
    );
  }

  // Field-level cursor validation (find ops that page by cursor)
  const CURSOR_OPS: McpOperation[] = [
    "findFirst",
    "findFirstOrThrow",
    "findMany",
  ];
  if (
    CURSOR_OPS.includes(operation as McpOperation) &&
    "cursor" in args &&
    args.cursor !== undefined
  ) {
    validateData(
      buildWhereUniqueSchema(model, fields) as ModelSchema,
      args.cursor,
      "cursor",
      errors,
    );
  }

  // Field-level data validation
  try {
    switch (operation as McpOperation) {
      case "create":
        if ("data" in args) {
          validateData(
            zodFactory.makeModelSchema(model, { optionality: "defaults" }),
            args.data,
            "data",
            errors,
          );
        }
        break;
      case "createMany":
      case "createManyAndReturn":
        if (Array.isArray(args.data)) {
          const schema = zodFactory.makeModelSchema(model, {
            optionality: "defaults",
          });
          args.data.forEach((item: unknown, i: number) =>
            validateData(schema, item, `data[${i}]`, errors),
          );
        }
        break;
      case "update":
      case "updateMany":
      case "updateManyAndReturn":
        if ("data" in args) {
          validateData(
            zodFactory.makeModelSchema(model, { optionality: "all" }),
            args.data,
            "data",
            errors,
          );
        }
        break;
      case "upsert":
        if ("create" in args) {
          validateData(
            zodFactory.makeModelSchema(model, { optionality: "defaults" }),
            args.create,
            "create",
            errors,
          );
        }
        if ("update" in args) {
          validateData(
            zodFactory.makeModelSchema(model, { optionality: "all" }),
            args.update,
            "update",
            errors,
          );
        }
        break;
    }
  } catch {
    // makeModelSchema may not support all model names at type level — skip
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}
