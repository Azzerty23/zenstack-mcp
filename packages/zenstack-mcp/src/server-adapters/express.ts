import { Router, json, urlencoded } from "express";
import type { Request, Response, NextFunction } from "express";
import type { SchemaDef } from "@zenstackhq/schema";
import type { AuthType } from "@zenstackhq/orm";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type {
  McpServerConfig,
  RouterAdapter,
  GenericRequest,
} from "../types.js";
import { extractModels, buildMcpServer } from "../server.js";
import { requestContext } from "../context.js";
import { authenticateMcpRequest, resolveAuthAdapter } from "./shared.js";

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
 * const { oauthRoutes, mcpMiddleware } = createExpressMcpHandler(config)
 * app.use(oauthRoutes)           // /.well-known/*, /oauth/*, /login, /register
 * app.use('/mcp', mcpMiddleware) // POST /mcp/ → MCP transport (requires Bearer)
 * ```
 */
export function createExpressMcpHandler<Schema extends SchemaDef>(
  config: McpServerConfig<Schema>,
): {
  oauthRoutes: ReturnType<typeof Router>;
  mcpMiddleware: ReturnType<typeof Router>;
} {
  const transport = config.transport ?? "streamable-http";
  if (transport !== "streamable-http") {
    throw new Error(
      `Express adapter only supports "streamable-http" transport. Got: "${transport}". ` +
        `Use the Hono adapter for SSE support.`,
    );
  }

  const authAdapter = resolveAuthAdapter(config.auth);

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
    const result = await authenticateMcpRequest(
      authAdapter,
      config.allowedOrigins,
      {
        origin: `${req.protocol}://${req.get("host")}`,
        originHeader: req.headers.origin,
        authorization: req.headers.authorization,
      },
    );
    if (!result.ok) {
      res.status(result.status).set(result.headers).json(result.body);
      return;
    }
    (req as Request & { mcpUser: unknown }).mcpUser = result.user;
    next();
  });

  const models = extractModels(config);

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
        const server = buildMcpServer(models, config);
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

  // MCP Streamable HTTP: clients issue GET to open a server→client SSE stream.
  // Stateless mode offers no such stream, so the spec mandates 405 (not 404);
  // clients handle it gracefully by staying POST-only.
  mcpRouter.get("/", (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").json({
      error: "method_not_allowed",
      error_description: "GET SSE stream not supported",
    });
  });

  return { oauthRoutes: oauthRouter, mcpMiddleware: mcpRouter };
}
