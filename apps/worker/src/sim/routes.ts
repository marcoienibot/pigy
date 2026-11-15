import {
  sandboxFaultSchema,
  sandboxFaultsSchema,
  sandboxFeedSchema,
} from "@pigy/core";
import { drizzle } from "drizzle-orm/d1";
import { type Context, Hono } from "hono";
import { requireUser } from "../auth/guards.ts";
import type { AppDependencies, AppEnv } from "../env.ts";
import { handleNotFound, InvalidField, parseJsonBody } from "../errors.ts";
import type { WorkspaceIdentity } from "../workspace/store.ts";
import { workspacesOf } from "../workspace/workspaces.ts";
import {
  armWorldFault,
  disarmWorld,
  WorldHostMissing,
  worldFaults,
  worldFeed,
  worldFetch,
  worldPage,
} from "./world.ts";

/**
 * The sandbox workspace of whoever is signed in. The routes of this file
 * name no workspace: whose simulated world they are about is decided here,
 * by the session and by nothing in the request, so that no address leads
 * to the world of somebody else.
 */
async function ownSandbox(
  c: Context<AppEnv>,
  { now }: AppDependencies,
): Promise<WorkspaceIdentity> {
  const ownerId = c.var.auth.user.id;
  const workspaces = await workspacesOf(drizzle(c.env.DB), ownerId, now());
  const sandbox = workspaces.find(
    ({ environment }) => environment === "sandbox",
  );
  if (!sandbox) throw new Error("The sandbox workspace is missing");
  return { ...sandbox, ownerId };
}

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

    const sandbox = await ownSandbox(c, dependencies);
    const contentType = c.req.header("Content-Type");
    try {
      return await worldFetch(c.env.SIM_WORLD, sandbox)(page, {
        method: c.req.method,
        ...(contentType && { headers: { "Content-Type": contentType } }),
        ...(c.req.method === "POST" && { body: await c.req.arrayBuffer() }),
      });
    } catch (error) {
      if (error instanceof WorldHostMissing) return handleNotFound(c);
      throw error;
    }
  });

  return app;
}

/**
 * Under `/api/sandbox`: what a person sees and does of the simulated world
 * of their sandbox, besides connecting accounts. @pigy/core has the
 * answers, in src/sandbox.ts.
 *
 * - The feed: what is published in the world, by account, for the page
 *   that shows where the posts of a sandbox went.
 * - The faults: making the next request to a simulated network fail, to
 *   see what pigy does about it.
 */
export function sandboxRoutes(dependencies: AppDependencies): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // Also refuses a request that changes something and comes from another
  // site.
  app.use(requireUser(dependencies));

  app.get("/feed", async (c) => {
    const sandbox = await ownSandbox(c, dependencies);
    return c.json(
      sandboxFeedSchema.parse(await worldFeed(c.env.SIM_WORLD, sandbox)),
    );
  });

  app.get("/faults", async (c) => {
    const sandbox = await ownSandbox(c, dependencies);
    return c.json(
      sandboxFaultsSchema.parse(await worldFaults(c.env.SIM_WORLD, sandbox)),
    );
  });

  app.post("/faults", async (c) => {
    const fault = await parseJsonBody(c, sandboxFaultSchema);
    const sandbox = await ownSandbox(c, dependencies);
    const outcome = await armWorldFault(c.env.SIM_WORLD, sandbox, fault);
    if (!outcome.ok) throw new InvalidField(outcome.field, outcome.message);
    return c.json(sandboxFaultsSchema.parse(outcome.faults));
  });

  app.delete("/faults", async (c) => {
    const sandbox = await ownSandbox(c, dependencies);
    return c.json(
      sandboxFaultsSchema.parse(await disarmWorld(c.env.SIM_WORLD, sandbox)),
    );
  });

  return app;
}
