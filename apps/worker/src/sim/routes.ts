import {
  sandboxFaultSchema,
  sandboxFaultsSchema,
  sandboxFeedSchema,
} from "@pigy/core";
import { drizzle } from "drizzle-orm/d1";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
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

/** Whether `location`, as a redirect names it, is an address at `origin`. */
function leadsBackTo(origin: string, location: string | null): boolean {
  if (location === null) return false;
  try {
    // An address without an origin of its own would be read against the
    // address of the page, which is at pigy's.
    return new URL(location, origin).origin === origin;
  } catch {
    return false;
  }
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
    const { pathname, search, origin } = new URL(c.req.url);
    const page = worldPage(pathname, search);
    if (!page) return handleNotFound(c);

    const sandbox = await ownSandbox(c, dependencies);
    const contentType = c.req.header("Content-Type");
    let response: Response;
    try {
      response = await worldFetch(
        c.env.SIM_WORLD,
        sandbox,
        origin,
      )(page, {
        method: c.req.method,
        ...(contentType && { headers: { "Content-Type": contentType } }),
        ...(c.req.method === "POST" && { body: await c.req.arrayBuffer() }),
      });
    } catch (error) {
      if (error instanceof WorldHostMissing) return handleNotFound(c);
      throw error;
    }
    // A page of a simulated network sends the browser on to one place:
    // back to this pigy, with how a connection went. The address of the
    // page is anybody's to write, and what a simulator makes of it is not
    // relied on here: an answer that would send the browser of somebody
    // who is signed in to another site, from pigy's own address, is not
    // passed on, whichever simulator gave it.
    if (response.status >= 300 && response.status < 400) {
      if (!leadsBackTo(origin, response.headers.get("Location"))) {
        throw new HTTPException(400, {
          message:
            "The simulated network would send the browser to another site",
        });
      }
    }
    return response;
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
