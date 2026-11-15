import { workspaceListResponseSchema } from "@pigy/core";
import { drizzle } from "drizzle-orm/d1";
import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireOwnOrigin, requireUser } from "../auth/guards.ts";
import type { AppDependencies, AppEnv } from "../env.ts";
import { connectWorkspace, ownWorkspace, workspacesOf } from "./workspaces.ts";

/** Under `/api`: which workspaces the caller has. */
export function workspaceRoutes(dependencies: AppDependencies): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/workspaces", requireUser(dependencies), async (c) => {
    const workspaces = await workspacesOf(
      drizzle(c.env.DB),
      c.var.auth.user.id,
      dependencies.now(),
    );
    return c.json(workspaceListResponseSchema.parse({ workspaces }));
  });

  return app;
}

/**
 * Lets through only a WebSocket handshake that one of pigy's own pages
 * started. A browser attaches the session cookie to a handshake that any
 * site starts, and a WebSocket is not subject to the same-origin policy, so
 * without this check another site could open a socket as whoever visits it.
 * Browsers send `Origin` with every handshake and scripts cannot set it.
 */
const requireOwnWebSocket: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    throw new HTTPException(426, {
      message: "This address only takes WebSocket connections",
    });
  }
  requireOwnOrigin(c);
  await next();
};

/**
 * Under `/sync`: the WebSocket through which a client keeps its copy of a
 * workspace up to date. SYNC.md describes what is said over it.
 */
export function syncRoutes(dependencies: AppDependencies): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get(
    "/:workspaceId",
    requireOwnWebSocket,
    requireUser(dependencies),
    async (c) => {
      const workspace = await ownWorkspace(
        drizzle(c.env.DB),
        c.req.param("workspaceId"),
        c.var.auth.user.id,
      );
      if (!workspace) {
        throw new HTTPException(404, {
          message: "There is no such workspace",
        });
      }

      const response = await connectWorkspace(c.env.WORKSPACE, workspace);
      if (response.status === 429) {
        throw new HTTPException(429, {
          message: "This workspace has too many connections open",
        });
      }
      if (!response.webSocket) {
        throw new Error(`The workspace answered with ${response.status}`);
      }
      return new Response(null, {
        status: 101,
        webSocket: response.webSocket,
        // What was set on the way here: the session cookie, if the session
        // was renewed by this request.
        headers: c.res.headers,
      });
    },
  );

  return app;
}
