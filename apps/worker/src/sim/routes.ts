import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { requireUser } from "../auth/guards.ts";
import type { AppDependencies, AppEnv } from "../env.ts";
import { handleNotFound } from "../errors.ts";
import { workspacesOf } from "../workspace/workspaces.ts";
import { worldFetch, worldPage } from "./world.ts";

/**
 * Under `/sim/network`: the pages of the simulated networks, where a person
 * who connects an account in their sandbox chooses which simulated account
 * it is. `/sim/network/<host>/<path>` is the page at `https://<host>/<path>`
 * of the simulated world.
 *
 * Whose world, the address does not say: it is the world of the sandbox
 * workspace of whoever is signed in, and of nobody else. So there is no
 * address that shows one person the world of another.
 */
export function simRoutes(dependencies: AppDependencies): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // `requireUser` also sees to it that a form of these pages is only taken
  // from the page itself, not from another site.
  app.on(["GET", "POST"], "/*", requireUser(dependencies), async (c) => {
    const { pathname, search } = new URL(c.req.url);
    const page = worldPage(pathname, search);
    if (!page) return handleNotFound(c);

    const ownerId = c.var.auth.user.id;
    const workspaces = await workspacesOf(
      drizzle(c.env.DB),
      ownerId,
      dependencies.now(),
    );
    const sandbox = workspaces.find(
      ({ environment }) => environment === "sandbox",
    );
    if (!sandbox) throw new Error("The sandbox workspace is missing");

    const contentType = c.req.header("Content-Type");
    try {
      return await worldFetch(c.env.SIM_WORLD, { ...sandbox, ownerId })(page, {
        method: c.req.method,
        ...(contentType && { headers: { "Content-Type": contentType } }),
        ...(c.req.method === "POST" && { body: await c.req.arrayBuffer() }),
      });
    } catch (error) {
      // The world has no such host.
      if (error instanceof TypeError) return handleNotFound(c);
      throw error;
    }
  });

  return app;
}
