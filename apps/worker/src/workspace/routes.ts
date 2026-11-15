import { workspaceListResponseSchema } from "@pigy/core";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { requireUser } from "../auth/guards.ts";
import type { AppDependencies, AppEnv } from "../env.ts";
import { workspacesOf } from "./workspaces.ts";

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
