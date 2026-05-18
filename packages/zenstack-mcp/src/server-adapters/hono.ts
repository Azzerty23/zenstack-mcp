import { Hono, type Context } from "hono";
import type { SchemaDef } from "@zenstackhq/schema";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import type {
  McpAuthAdapter,
  McpBuiltInAuthOptions,
  McpServerConfig,
  RouterAdapter,
  GenericRequest,
  GenericResponse,
} from "../types.js";
import {
  builtInMcpAuth,
  isBuiltInAuthOptions,
} from "../auth-adapters/oauth/index.js";
import { extractModels, buildMcpServer } from "../server.js";
import type { AuthType } from "@zenstackhq/orm";
import { requestContext } from "../context.js";

function resolveAuthAdapter(
  auth: McpAuthAdapter | McpBuiltInAuthOptions,
): McpAuthAdapter {
  return isBuiltInAuthOptions(auth) ? builtInMcpAuth(auth) : auth;
}

export type HonoMcpEnv = { Variables: { user: unknown } };
type Env = HonoMcpEnv;

function sendGenericResponse(c: Context, res: GenericResponse): Response {
  if (res.type === "html")
    return new Response(res.html, {
      status: res.status ?? 200,
      headers: { "content-type": "text/html; charset=UTF-8" },
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return c.json(res.data as any, (res.status ?? 200) as any);
}

function honoRouterAdapter(app: Hono<Env>): RouterAdapter {
  return {
    get(path, handler) {
      app.get(path, async (c) => {
        const url = new URL(c.req.url);
        const req: GenericRequest = {
          origin: url.origin,
          query: c.req.query() as Record<string, string>,
          authorization: c.req.header("Authorization"),
          body: async () => ({}),
        };
        return sendGenericResponse(c, await handler(req));
      });
    },
    post(path, handler) {
      app.post(path, async (c) => {
        const url = new URL(c.req.url);
        const req: GenericRequest = {
          origin: url.origin,
          query: c.req.query() as Record<string, string>,
          authorization: c.req.header("Authorization"),
          body: async () => {
            const ct = c.req.header("content-type") ?? "";
            if (ct.includes("application/json")) {
              return c.req.json() as Promise<Record<string, unknown>>;
            }
            return c.req.parseBody() as Promise<Record<string, unknown>>;
          },
        };
        return sendGenericResponse(c, await handler(req));
      });
    },
  };
}

/**
 * Creates Hono apps for a ZenStack MCP server.
 *
 * Returns two separate apps that must be mounted independently:
 * - `oauthRoutes`: OAuth 2.0 discovery + token endpoints — mount at the app root
 * - `mcpMiddleware`: Bearer auth + MCP transport — mount at your desired path
 *
 * @example
 * ```ts
 * const { oauthRoutes, mcpMiddleware } = createHonoMcpHandler(options)
 * app.route('/', oauthRoutes)     // /.well-known/*, /oauth/*, /login, /register
 * app.route('/mcp', mcpMiddleware) // POST /mcp/ → MCP transport (requires Bearer)
 * ```
 */
export function createHonoMcpHandler<Schema extends SchemaDef>(
  config: McpServerConfig<Schema>,
): { oauthRoutes: Hono<Env>; mcpMiddleware: Hono<Env> } {
  const authAdapter = resolveAuthAdapter(config.auth);
  const models = extractModels<Schema>(config);

  // OAuth routes — mount at root so discovery is at /.well-known/oauth-authorization-server
  const oauthApp = new Hono<Env>();
  authAdapter.mountRoutes(honoRouterAdapter(oauthApp));

  // MCP middleware — all requests require a Bearer token
  const mcpApp = new Hono<Env>();

  mcpApp.use("/*", async (c, next) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json(
        { error: "unauthorized", error_description: "Bearer token required" },
        401,
      );
    }

    try {
      const token = authHeader.slice(7);
      const user = await authAdapter.validateToken(token);
      c.set("user", user);
    } catch {
      return c.json({ error: "invalid_token" }, 401);
    }

    return next();
  });

  const transport = config.transport ?? "streamable-http";

  if (transport === "streamable-http" || transport === "both") {
    mcpApp.post("/", async (c) => {
      const user = c.get("user") as AuthType<Schema>;
      const mcpTransport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        // Without enableJsonResponse, handleRequest returns a streaming Response immediately
        // while the MCP handler runs asynchronously (via Promise.resolve().then() chain).
        // server.close() in the finally block would close the SSE stream controller before
        // the handler writes its response, leaving Claude with an empty stream and causing
        // it to retry auth indefinitely. With enableJsonResponse, handleRequest resolves
        // only after send() completes (via resolveJson), so server.close() is always safe.
        enableJsonResponse: true,
      });
      const server = buildMcpServer<Schema>(models, config);
      try {
        await server.connect(mcpTransport);
        const response = await requestContext.run({ user }, () =>
          mcpTransport.handleRequest(c.req.raw),
        );
        // Read the body fully so no ReadableStream remains in-flight after this handler returns.
        const body = await response.arrayBuffer();
        // Close the server BEFORE returning the response — this ensures no async work
        // (event-listener teardown, stream controller close) leaks into the CF Workers
        // event loop after the Response is handed back. A pending post-response Promise
        // (e.g. via waitUntil) that rejects or hangs marks the isolate as errored and
        // causes every subsequent request to be killed immediately.
        await server.close();
        return new Response(body, { status: response.status, headers: response.headers });
      } catch (err) {
        await server.close().catch(() => {});
        throw err;
      }
    });

    mcpApp.delete("/", (c) => c.json({ ok: true }));
  }

  if (transport === "sse" || transport === "both") {
    const SSE_SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
    const sseSessions = new Map<
      string,
      {
        transport: WebStandardStreamableHTTPServerTransport;
        user: unknown;
        createdAt: number;
      }
    >();

    mcpApp.get("/sse", async (c) => {
      const user = c.get("user") as AuthType<Schema>;
      const sessionId = crypto.randomUUID();
      const mcpTransport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
      });
      const server = buildMcpServer<Schema>(models, config);

      // Evict sessions that outlived the TTL (covers abrupt disconnects where onclose never fires).
      const now = Date.now();
      for (const [id, session] of sseSessions) {
        if (now - session.createdAt > SSE_SESSION_TTL_MS)
          sseSessions.delete(id);
      }
      sseSessions.set(sessionId, {
        transport: mcpTransport,
        user,
        createdAt: now,
      });
      // For SSE the connection is long-lived, so close the server when the transport
      // closes rather than in a finally block (which would terminate the stream early).
      mcpTransport.onclose = () => {
        sseSessions.delete(sessionId);
        server.close().catch(() => {});
      };

      return requestContext.run({ user }, async () => {
        await server.connect(mcpTransport);
        return mcpTransport.handleRequest(c.req.raw);
      });
    });

    mcpApp.post("/sse", async (c) => {
      const sessionId = c.req.header("mcp-session-id");
      if (!sessionId) {
        return c.json({ error: "missing mcp-session-id header" }, 400);
      }
      const session = sseSessions.get(sessionId);
      if (!session) {
        return c.json({ error: "unknown or expired session" }, 404);
      }
      // The auth middleware already validated this request's Bearer token and set c.get("user").
      // Using session.user (stored at SSE open time) would silently continue with a stale
      // identity if the token was rotated between messages.
      const user = c.get("user") as AuthType<Schema>;
      return requestContext.run({ user }, () =>
        session.transport.handleRequest(c.req.raw),
      );
    });
  }

  return { oauthRoutes: oauthApp, mcpMiddleware: mcpApp };
}
