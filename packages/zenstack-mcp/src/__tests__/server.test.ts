import { describe, test, expect } from "bun:test";
import { extractEnums, extractModels, extractTypeDefs } from "../server.js";
import type { McpServerConfig } from "../types.js";
import type { SchemaDef } from "@zenstackhq/schema";

// Minimal schema shape that satisfies the runtime assertRawSchema check
function makeSchema(models: Record<string, unknown>) {
  return { models } as unknown as SchemaDef;
}

const userModel = {
  name: "User",
  fields: {
    id: { type: "String", id: true },
    email: { type: "String" },
  },
};

const postModel = {
  name: "Post",
  fields: {
    id: { type: "String", id: true },
    title: { type: "String" },
    authorId: { type: "String" },
  },
};

const commentModel = {
  name: "Comment",
  fields: {
    id: { type: "String", id: true },
    body: { type: "String" },
  },
};

const noOpConfig = {
  getClient: async () => ({}),
  auth: { mountRoutes: () => {}, validateToken: async () => ({}) },
} as Partial<McpServerConfig<SchemaDef>>;

function config(overrides: Partial<McpServerConfig<SchemaDef>>): McpServerConfig<SchemaDef> {
  return { ...noOpConfig, ...overrides } as McpServerConfig<SchemaDef>;
}

describe("extractModels — basic extraction", () => {
  test("extracts all models when no filter is provided", () => {
    const schema = makeSchema({ User: userModel, Post: postModel });
    const models = extractModels(config({ schema }));
    expect(models.map((m) => m.name).sort()).toEqual(["Post", "User"]);
  });

  test("sets dbName to lowerFirst of model name", () => {
    const schema = makeSchema({ User: userModel });
    const models = extractModels(config({ schema }));
    expect(models[0]!.dbName).toBe("user");
  });

  test("maps fields correctly", () => {
    const schema = makeSchema({ User: userModel });
    const models = extractModels(config({ schema }));
    const idField = models[0]!.fields.find((f) => f.name === "id");
    expect(idField?.isId).toBe(true);
    expect(idField?.type).toBe("String");
  });

  test("marks optional fields", () => {
    const schema = makeSchema({
      User: {
        name: "User",
        fields: {
          id: { type: "String", id: true },
          bio: { type: "String", optional: true },
        },
      },
    });
    const models = extractModels(config({ schema }));
    const bioField = models[0]!.fields.find((f) => f.name === "bio");
    expect(bioField?.isRequired).toBe(false);
  });

  test("marks relation fields", () => {
    const schema = makeSchema({
      Post: {
        name: "Post",
        fields: {
          id: { type: "String", id: true },
          author: { type: "User", relation: {} },
        },
      },
    });
    const models = extractModels(config({ schema }));
    const authorField = models[0]!.fields.find((f) => f.name === "author");
    expect(authorField?.isRelation).toBe(true);
  });

  test("throws for invalid schema shape", () => {
    expect(() => extractModels(config({ schema: null as unknown as SchemaDef }))).toThrow();
    expect(() => extractModels(config({ schema: { notModels: {} } as unknown as SchemaDef }))).toThrow();
  });
});

describe("extractModels — @@map attribute", () => {
  test("extracts mapName from @@map attribute", () => {
    const schema = makeSchema({
      User: {
        name: "User",
        fields: { id: { type: "String", id: true } },
        attributes: [
          { name: "@@map", args: [{ value: { kind: "literal", value: "users" } }] },
        ],
      },
    });
    const models = extractModels(config({ schema }));
    expect(models[0]!.mapName).toBe("users");
  });

  test("omits mapName when @@map is absent", () => {
    const schema = makeSchema({ User: userModel });
    const models = extractModels(config({ schema }));
    expect(models[0]!.mapName).toBeUndefined();
  });

  test("dbName is still lowerFirst even when @@map is present", () => {
    const schema = makeSchema({
      User: {
        name: "User",
        fields: { id: { type: "String", id: true } },
        attributes: [
          { name: "@@map", args: [{ value: { kind: "literal", value: "users" } }] },
        ],
      },
    });
    const models = extractModels(config({ schema }));
    expect(models[0]!.dbName).toBe("user");
  });
});

describe("extractModels — include/exclude filters", () => {
  const schema = makeSchema({ User: userModel, Post: postModel, Comment: commentModel });

  test("include limits to specified models", () => {
    const models = extractModels(config({ schema, include: ["User", "Post"] }));
    expect(models.map((m) => m.name).sort()).toEqual(["Post", "User"]);
  });

  test("exclude removes specified models", () => {
    const models = extractModels(config({ schema, exclude: ["Comment"] }));
    expect(models.map((m) => m.name).sort()).toEqual(["Post", "User"]);
  });

  test("include with non-existent model returns empty", () => {
    const models = extractModels(config({ schema, include: ["Unknown"] }));
    expect(models).toHaveLength(0);
  });
});

describe("extractModels — mcpConfig filter", () => {
  const schema = makeSchema({ User: userModel, Post: postModel });

  test("exposes only models with exposed: true", () => {
    const models = extractModels(config({
      schema,
      mcpConfig: {
        models: {
          User: { exposed: true },
          Post: { exposed: false },
        },
      },
    }));
    expect(models.map((m) => m.name)).toEqual(["User"]);
  });

  test("models absent from mcpConfig are not exposed", () => {
    const models = extractModels(config({
      schema,
      mcpConfig: {
        models: {
          User: { exposed: true },
        },
      },
    }));
    expect(models.map((m) => m.name)).toEqual(["User"]);
  });

  test("mcpConfig.models[name].operations restricts operations", () => {
    const models = extractModels(config({
      schema,
      mcpConfig: {
        models: {
          User: { exposed: true, operations: ["findMany", "findUnique"] },
        },
      },
    }));
    expect(models[0]!.operations).toEqual(["findMany", "findUnique"]);
  });

  test("mcpConfig takes priority over include/exclude", () => {
    const models = extractModels(config({
      schema,
      include: ["Post"],
      mcpConfig: {
        models: {
          User: { exposed: true },
          Post: { exposed: false },
        },
      },
    }));
    expect(models.map((m) => m.name)).toEqual(["User"]);
  });
});

describe("extractModels — modelOperations override", () => {
  const schema = makeSchema({ User: userModel, Post: postModel });

  test("modelOperations restricts operations for a model", () => {
    const models = extractModels(config({
      schema,
      modelOperations: {
        User: ["findMany"],
      },
    }));
    const user = models.find((m) => m.name === "User")!;
    expect(user.operations).toEqual(["findMany"]);
  });

  test("modelOperations takes priority over mcpConfig operations", () => {
    const models = extractModels(config({
      schema,
      mcpConfig: {
        models: {
          User: { exposed: true, operations: ["findMany", "findUnique"] },
        },
      },
      modelOperations: {
        User: ["count"],
      },
    }));
    const user = models.find((m) => m.name === "User")!;
    expect(user.operations).toEqual(["count"]);
  });
});

describe("extractModels — attributes", () => {
  test("carries field- and model-level attributes through", () => {
    const schema = makeSchema({
      Post: {
        name: "Post",
        fields: {
          id: { type: "String", id: true, attributes: [{ name: "@id" }] },
        },
        attributes: [{ name: "@@map", args: [{ value: { kind: "literal", value: "posts" } }] }],
      },
    });
    const post = extractModels(config({ schema })).find((m) => m.name === "Post")!;
    expect(post.attributes).toEqual([{ name: "@@map", args: [{ value: { kind: "literal", value: "posts" } }] }] as never);
    expect(post.fields[0]!.attributes).toEqual([{ name: "@id" }] as never);
  });
});

describe("extractEnums", () => {
  test("returns [] when the schema has no enums", () => {
    const schema = makeSchema({ User: userModel });
    expect(extractEnums(config({ schema }))).toEqual([]);
  });

  test("extracts enum names and member values", () => {
    const schema = {
      models: { User: userModel },
      enums: { Role: { name: "Role", values: { USER: "USER", ADMIN: "ADMIN" } } },
    } as unknown as SchemaDef;
    const enums = extractEnums(config({ schema }));
    expect(enums).toHaveLength(1);
    expect(enums[0]!.name).toBe("Role");
    expect(enums[0]!.values).toEqual(["USER", "ADMIN"]);
  });
});

describe("extractTypeDefs", () => {
  test("returns [] when the schema has no type declarations", () => {
    const schema = makeSchema({ User: userModel });
    expect(extractTypeDefs(config({ schema }))).toEqual([]);
  });

  test("extracts type declarations with their fields", () => {
    const schema = {
      models: { User: userModel },
      typeDefs: {
        Address: {
          name: "Address",
          fields: { street: { type: "String" }, zip: { type: "String", optional: true } },
        },
      },
    } as unknown as SchemaDef;
    const typeDefs = extractTypeDefs(config({ schema }));
    expect(typeDefs).toHaveLength(1);
    expect(typeDefs[0]!.name).toBe("Address");
    expect(typeDefs[0]!.fields.map((f) => f.name)).toEqual(["street", "zip"]);
    expect(typeDefs[0]!.fields[1]!.isRequired).toBe(false);
  });
});
