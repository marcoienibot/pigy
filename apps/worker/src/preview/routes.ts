import {
  linkCardRequestSchema,
  linkCardResponseSchema,
  mentionsRequestSchema,
  mentionsResponseSchema,
  previewsPerMinute,
} from "@pigy/core";
import { fetchLinkCard } from "@pigy/providers/card";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireUser } from "../auth/guards.ts";
import { previewUses } from "../db/schema.ts";
import type { AppDependencies, AppEnv } from "../env.ts";
import { parseJsonBody } from "../errors.ts";
import { blueskyKeysFor } from "../network/bluesky-client.ts";
import { providerOf } from "../network/providers.ts";
import { reachOf } from "../network/reach.ts";
import { vaultFor } from "../vault.ts";
import { ownWorkspace } from "../workspace/workspaces.ts";

/**
 * What the editor of a draft asks before a post goes out: the card of a
 * link, and which of the accounts that a text mentions there are.
 * @pigy/core has the requests and the answers, in src/preview.ts.
 *
 * Both make pigy ask a host that a person named, so both are for whoever
 * is signed in, about a workspace of their own, and counted per person.
 * Where the request goes is decided by the environment of the workspace,
 * `reachOf`, as for an adapter: a sandbox asks its simulated world, with
 * its simulated web, and nothing else. What comes back is text, checked
 * against its schema, and nothing here keeps it.
 */

const minuteMs = 60_000;

export function previewRoutes(dependencies: AppDependencies): Hono<AppEnv> {
  const {
    fetch,
    now,
    developmentCredentialKeys,
    developmentBlueskyClientKeys,
  } = dependencies;
  const app = new Hono<AppEnv>();
  // Also refuses a request that does not come from pigy's own pages.
  const signedIn = requireUser(dependencies);

  /** The workspace in the path, which has to be the caller's. */
  const workspaceOf = async (c: Context<AppEnv>) => {
    const workspace = await ownWorkspace(
      drizzle(c.env.DB),
      c.req.param("workspaceId") ?? "",
      c.var.auth.user.id,
    );
    if (!workspace) {
      throw new HTTPException(404, { message: "There is no such workspace" });
    }
    return workspace;
  };

  /**
   * Counts a preview for whoever asks, and refuses the one that is over
   * what a person may ask for in a minute. One statement, so that two
   * requests at once are both counted.
   */
  const counted = async (c: Context<AppEnv>) => {
    const minute = Math.floor(now().getTime() / minuteMs) * minuteMs;
    const [use] = await drizzle(c.env.DB)
      .insert(previewUses)
      .values({ userId: c.var.auth.user.id, windowStart: minute, count: 1 })
      .onConflictDoUpdate({
        target: previewUses.userId,
        set: {
          // Both from the row as it was: the count goes on within the
          // minute, and begins anew with the next.
          count: sql`case when ${previewUses.windowStart} = excluded.window_start then ${previewUses.count} + 1 else 1 end`,
          windowStart: sql`excluded.window_start`,
        },
      })
      .returning({ count: previewUses.count });
    if ((use?.count ?? 0) > previewsPerMinute) {
      throw new HTTPException(429, {
        message:
          "pigy was asked for more previews than it makes in a minute. Try again in a moment.",
      });
    }
  };

  app.post("/workspaces/:workspaceId/link-card", signedIn, async (c) => {
    const workspace = await workspaceOf(c);
    const { url } = await parseJsonBody(c, linkCardRequestSchema);
    await counted(c);
    // The page is read with the reach of the workspace and with nothing
    // of the person: no cookie and no credentials go with it. What goes
    // wrong at the other end is no error here. The link has no card.
    const card = await fetchLinkCard(
      reachOf(workspace, c.env, fetch).fetch,
      url,
    );
    return c.json(linkCardResponseSchema.parse({ card }));
  });

  app.post("/workspaces/:workspaceId/mentions", signedIn, async (c) => {
    const workspace = await workspaceOf(c);
    const { network, names } = await parseJsonBody(c, mentionsRequestSchema);
    await counted(c);
    const { origin } = new URL(c.req.url);
    // An adapter is made with the vault, which this pigy may not have.
    // It could publish nothing then either.
    const vault = vaultFor(c.env, developmentCredentialKeys, origin);
    const provider =
      vault &&
      providerOf(network, workspace, {
        env: c.env,
        fetch,
        now,
        vault,
        blueskyClientKeys: blueskyKeysFor(
          c.env,
          developmentBlueskyClientKeys,
          origin,
        ),
      }).provider;
    const known = provider?.mentionable
      ? await provider.mentionable(names)
      : null;
    return c.json(mentionsResponseSchema.parse({ known }));
  });

  return app;
}
