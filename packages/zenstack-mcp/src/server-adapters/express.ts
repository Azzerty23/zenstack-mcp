import { Router, json, urlencoded } from "express";
import type { Request, Response, NextFunction } from "express";
import type { SchemaDef } from "@zenstackhq/schema";
import type { AuthType } from "@zenstackhq/orm";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createSchemaFactory } from "@zenstackhq/zod";
import type {
  McpAuthAdapter,
  McpBuiltInAuthOptions,
  McpServerOptions,
  RouterAdapter,
  GenericRequest,
} from "../types.js";
import {
  isBuiltInAuthOptions,
  builtInMcpAuth,
} from "../auth-adapters/oauth/index.js";
import { extractModels, buildMcpServer } from "../server.js";
import { requestContext } from "../context.js";

function expressRouterAdapter(
  router: ReturnType<typeof Router>,
): RouterAdapter {
  return {
    get(path, handler) {
      router.get(path, async (req: Request, res: Response) => {
        const origin = `${req.protocol}://${req.get("host")}`;
        const genericReq: GenericRequest = {
          origin,
          query: req.query as Record<string, string>,
          authorization: req.headers.authorization,
          body: async () => req.body as Record<string, unknown>,
        };
        const result = await handler(genericReq);
        if (result.type === "html") {
          res.status(result.status ?? 200).send(result.html);
        } else {
          res.status(result.status ?? 200).json(result.data);
        }
      });
    },
    post(path, handler) {
      router.post(path, async (req: Request, res: Response) => {
        const origin = `${req.protocol}://${req.get("host")}`;
        const genericReq: GenericRequest = {
          origin,
          query: req.query as Record<string, string>,
          authorization: req.headers.authorization,
          body: async () => req.body as Record<string, unknown>,
        };
        const result = await handler(genericReq);
        if (result.type === "html") {
          res.status(result.status ?? 200).send(result.html);
        } else {
          res.status(result.status ?? 200).json(result.data);
        }
      });
    },
  };
}

/**
 * Creates Express routers for a ZenStack MCP server.
 *
 * Returns two separate routers that must be mounted independently:
 * - `oauthRoutes`: OAuth 2.0 discovery + token endpoints — mount at the app root
 * - `mcpMiddleware`: Bearer auth + MCP streamable-HTTP transport — mount at your desired path
 *
 * @example
 * ```ts
 * const { oauthRoutes, mcpMiddleware } = createExpressMcpHandler(options)
 * app.use(oauthRoutes)           // /.well-known/*, /oauth/*, /login, /register
 * app.use('/mcp', mcpMiddleware) // POST /mcp/ → MCP transport (requires Bearer)
 * ```
 */
export function createExpressMcpHandler<Schema extends SchemaDef>(
  options: McpServerOptions<Schema>,
): { oauthRoutes: ReturnType<typeof Router>; mcpMiddleware: ReturnType<typeof Router> } {
  const transport = options.transport ?? "streamable-http";
  if (transport !== "streamable-http") {
    throw new Error(
      `Express adapter only supports "streamable-http" transport. Got: "${transport}". ` +
      `Use the Hono adapter for SSE support.`,
    );
  }

  const authAdapter: McpAuthAdapter = isBuiltInAuthOptions(options.auth)
    ? builtInMcpAuth(options.auth)
    : (options.auth as McpAuthAdapter);

  // OAuth routes — mount at root so discovery is at /.well-known/oauth-authorization-server
  const oauthRouter = Router();
  oauthRouter.use(json());
  oauthRouter.use(urlencoded({ extended: false }));
  authAdapter.mountRoutes(expressRouterAdapter(oauthRouter));

  // MCP middleware — all requests require a Bearer token
  const mcpRouter = Router();
  mcpRouter.use(json());
  mcpRouter.use(urlencoded({ extended: false }));

  mcpRouter.use(async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({
        error: "unauthorized",
        error_description: "Bearer token required",
      });
      return;
    }

    try {
      const token = authHeader.slice(7);
      (req as Request & { mcpUser: unknown }).mcpUser =
        await authAdapter.validateToken(token);
      next();
    } catch {
      res.status(401).json({ error: "invalid_token" });
    }
  });

  const models = extractModels(options);
  const zodFactory = createSchemaFactory(options.schema as SchemaDef);

  mcpRouter.post(
    "/",
    async (req: Request & { mcpUser?: unknown }, res: Response) => {
      const user = req.mcpUser;
      if (user === undefined) {
        res.status(500).json({ error: "internal_error" });
        return;
      }
      await requestContext.run({ user: user as AuthType<Schema> }, async () => {
        const mcpTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        const server = buildMcpServer(models, options, zodFactory);
        try {
          await server.connect(mcpTransport);
          await mcpTransport.handleRequest(req, res, req.body);
        } finally {
          // server.connect() registers event listeners; without close() they accumulate
          // across requests and produce MaxListenersExceededWarning under load.
          await server.close();
        }
      });
    },
  );

  return { oauthRoutes: oauthRouter, mcpMiddleware: mcpRouter };
}
