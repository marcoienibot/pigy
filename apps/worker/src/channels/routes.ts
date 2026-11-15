import {
  type ConnectOutcome,
  type ConnectResult,
  channelLimits,
  connectCallbackPath,
  connectRequestSchema,
  connectResponseSchemaFor,
  connectReturnPath,
  disconnectResponseSchema,
  idSchema,
  type Network,
  networkSchema,
  sandboxServers,
  uuidv7,
} from "@pigy/core";
import { type Account, type Json, ProviderError } from "@pigy/providers";
import { drizzle } from "drizzle-orm/d1";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { authenticateWithCookie, requireUser } from "../auth/guards.ts";
import type { AppDependencies, AppEnv } from "../env.ts";
import { InvalidField, loggable, parseJsonBody } from "../errors.ts";
import { type ProviderContext, providerOf } from "../network/providers.ts";
import type { Reach } from "../network/reach.ts";
import { WorldHostMissing } from "../sim/world.ts";
import { VaultError, vaultFor } from "../vault.ts";
import type {
  StoredChannelAccess,
  WorkspaceIdentity,
} from "../workspace/store.ts";
import {
  connectChannel,
  disconnectChannel,
  ownWorkspace,
} from "../workspace/workspaces.ts";
import { keepPending, takePending } from "./pending.ts";

/**
 * Connecting an account to a workspace and disconnecting it. @pigy/core has
 * the requests and the answers, in src/connect.ts.
 *
 * This is the only code that sees the credentials of a channel: it gets
 * them from the adapter and seals them before they go to the workspace,
 * and it opens them to hand them back to the adapter that gives the access
 * up. They are in no answer and no log.
 */

/**
 * What the sealed credentials of a channel belong to: the account, in its
 * workspace. Sealed for one, they do not open for another.
 */
function credentialsContext(
  workspace: WorkspaceIdentity,
  { network, accountId }: Pick<StoredChannelAccess, "network" | "accountId">,
): string[] {
  return ["channel", workspace.id, network, accountId];
}

/** `text`, cut to at most `length` and never in the middle of a character. */
function clipped(text: string, length: number): string {
  let clip = "";
  for (const character of text) {
    if (clip.length + character.length > length) break;
    clip += character;
  }
  return clip;
}

/**
 * An account as a network describes it, as the arguments of the mutator
 * that stores it. A network decides what its accounts are called and how
 * long that is, so the texts are cut to what a channel holds. An ID is not
 * cut: the mutator refuses one that is too long. Of the addresses, a
 * channel gets the ones that a browser can open.
 */
function channelOf(
  account: Account,
  expiresAt: Date | null,
  { publicUrl }: Reach,
  now: Date,
) {
  const address = (url: string | null) => {
    const open = publicUrl(url);
    return open !== null && open.length <= channelLimits.urlLength
      ? open
      : null;
  };
  return {
    // Not used if the account has a channel already.
    id: uuidv7(now),
    accountId: account.id,
    handle: clipped(account.handle, channelLimits.handleLength),
    name: clipped(account.name, channelLimits.nameLength),
    avatarUrl: address(account.avatarUrl),
    profileUrl: address(account.profileUrl),
    expiresAt: expiresAt?.getTime() ?? null,
  };
}

/**
 * What to tell a person who named a server that the simulated world of
 * their sandbox does not have: which one it has, where the network has one
 * to name.
 */
function notInSandbox(network: Network, host: string): string {
  const server = sandboxServers[network];
  return server
    ? `The sandbox has no server ${host}. Enter ${server}, its simulated server.`
    : `The sandbox has no server ${host}.`;
}

/** Under `/api`: starting a connection, and disconnecting. */
export function channelRoutes(dependencies: AppDependencies): Hono<AppEnv> {
  const { fetch, now, developmentCredentialKeys } = dependencies;
  const app = new Hono<AppEnv>();
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

  app.post("/workspaces/:workspaceId/connect", signedIn, async (c) => {
    const workspace = await workspaceOf(c);
    const { network, identifier } = await parseJsonBody(
      c,
      connectRequestSchema,
    );
    const { origin } = new URL(c.req.url);
    // Before anything else: a connection that cannot be stored sealed is
    // not begun.
    const vault = vaultFor(c.env, developmentCredentialKeys, origin);
    if (!vault) {
      throw new HTTPException(503, {
        message: "This pigy is not set up to connect accounts.",
      });
    }
    const connection = providerOf(network, workspace, {
      env: c.env,
      fetch,
      now,
      vault,
    });
    if (!connection) {
      throw new InvalidField(
        "network",
        `pigy cannot connect accounts of ${network} yet.`,
      );
    }

    const start = await connection.provider
      .beginConnect({
        // Where the network sends the browser back to. On the networks
        // that have a registration of the operator's, it has to be
        // registered there, character by character.
        redirectUri: origin + connectCallbackPath(network),
        identifier,
      })
      .catch((error: unknown) => {
        if (!(error instanceof ProviderError)) throw error;
        // A sandbox reaches its simulated world and nothing else. A server
        // that the world does not have will never answer there, whatever
        // the adapter makes of it, so this is about what the person
        // entered and not something to try again later.
        if (error.cause instanceof WorldHostMissing) {
          throw new InvalidField(
            "identifier",
            notInSandbox(network, error.cause.host),
          );
        }
        // `fail` is about what the person entered: no such server, not one
        // that pigy can post to. The message is written for the person,
        // and holds no secret.
        if (error.kind === "fail") {
          throw new InvalidField("identifier", error.message);
        }
        // Anything else is the trouble of a server that may be fine later.
        throw new HTTPException(502, { message: error.message });
      });
    // Checked before anything is kept of the connection: a page of the
    // app sends the browser to this address.
    const answer = connectResponseSchemaFor(origin).parse({
      url: connection.reach.browserUrl(start.url, origin),
    });
    await keepPending(
      drizzle(c.env.DB),
      vault,
      {
        state: start.state,
        sessionId: c.var.sessionId,
        workspaceId: workspace.id,
        network,
        pending: start.pending,
      },
      now(),
    );
    return c.json(answer);
  });

  const noSuchChannel = () =>
    new HTTPException(404, { message: "There is no such channel" });

  app.delete(
    "/workspaces/:workspaceId/channels/:channelId",
    signedIn,
    async (c) => {
      const workspace = await workspaceOf(c);
      const channelId = c.req.param("channelId");
      if (!idSchema.safeParse(channelId).success) throw noSuchChannel();

      // The channel goes first, and hands over the access that it held in
      // the same transaction of its workspace. So what is given back below
      // is what the channel had when it went, and no channel is left with
      // an access that was given back, whatever fails from here on. An
      // account that is connected again meanwhile gets a channel of its
      // own, which this request does not touch.
      //
      // One case is left, on a network that gives a new connection the
      // access of the one before. Mastodon does: it hands out the token
      // that the account has with the same registration already. An account
      // that is connected again while this request is on its way can get
      // the very token that is revoked below, and then has a channel that
      // says `connected` with an access that is gone. Nothing here can
      // tell, since the token is the same. That channel turns out to need
      // connecting again when it is next used, like the channel of another
      // workspace that shared the access.
      const disconnecting = (async () => {
        const removed = await disconnectChannel(
          c.env.WORKSPACE,
          workspace,
          channelId,
        );
        if (!removed.ok) return removed;
        // Whether or not the network takes the access back, the channel is
        // gone: one that could only be removed while its network answers,
        // or while its credentials open, could stay for ever.
        const { origin } = new URL(c.req.url);
        const vault = vaultFor(c.env, developmentCredentialKeys, origin);
        const revoked =
          vault !== undefined &&
          (await giveBack(workspace, removed.access, {
            env: c.env,
            fetch,
            now,
            vault,
          }));
        return { ok: true as const, revoked };
      })();
      // From the removal on, the work goes to its end whether or not
      // anybody waits for the answer. The runtime drops what is left of a
      // request when its client goes away, unless it was asked to keep it
      // going, and the removal is where the credentials leave the
      // workspace: somebody who clicks and closes the tab would leave an
      // access that nobody gives back, and that nothing is left to give
      // back with. A second request finds no channel.
      //
      // Two cases are left, and are accepted. In both, the access stands
      // at the network until the person takes it back there, and pigy has
      // kept nothing of it:
      //
      // - The answer of the workspace is lost on its way, after the
      //   workspace has removed the channel. The credentials went with it.
      // - The revocation fails once the person has left, or takes longer
      //   than the 30 seconds that the runtime gives a request whose client
      //   is gone. Nobody is there to be told.
      //
      // Closing them would take a place for credentials that wait to be
      // revoked, outside the channel, and something that tries again later.
      //
      // The runtime is handed a promise that never rejects. It reports a
      // rejection of what it keeps going as an exception that nobody
      // caught, with the error as it is, next to the one that the route
      // lets through below: logged twice, once without `loggable`.
      c.executionCtx.waitUntil(disconnecting.catch(() => {}));

      const outcome = await disconnecting;
      if (!outcome.ok && outcome.code === "not_found") throw noSuchChannel();
      if (!outcome.ok) throw new Error(`Not disconnected: ${outcome.message}`);
      return c.json(
        disconnectResponseSchema.parse({ revoked: outcome.revoked }),
      );
    },
  );

  return app;
}

/**
 * Gives the access that a channel had to its account back to the network,
 * and returns whether that worked. It never throws: the channel is gone by
 * then, and whoever disconnects is told whether the access went with it.
 */
async function giveBack(
  workspace: WorkspaceIdentity,
  access: StoredChannelAccess,
  context: ProviderContext,
): Promise<boolean> {
  try {
    if (access.credentials === null) return false;
    const connection = providerOf(access.network, workspace, context);
    if (!connection) return false;
    const credentials = await context.vault.open(
      credentialsContext(workspace, access),
      access.credentials,
    );
    // Checked by the adapter, against its own schema.
    await connection.provider.disconnect(credentials as Json);
    return true;
  } catch (error) {
    if (error instanceof ProviderError || error instanceof VaultError) {
      // Their messages hold no secret.
      console.warn(
        `The access of a channel was not given back: ${error.message}`,
      );
    } else {
      console.error(
        "The access of a channel was not given back",
        loggable(error),
      );
    }
    return false;
  }
}

/**
 * Under `/connect`: where a network sends the browser back to, with the
 * answer to a connection that began with `POST …/connect`.
 *
 * The request comes from another site, by a navigation, so it proves
 * nothing by itself. What it is believed for is its `state`: a value that
 * pigy made up when the connection began, that nobody can guess, and that
 * is good once and only in the session that began. So one person cannot
 * finish in their browser what another began, which would connect the
 * account of the one to the workspace of the other.
 *
 * It always answers with a redirect to a page of the app, never with an
 * error, whatever fails on the way: a person is looking at it. Where it
 * leads is fixed, and says how the connection ended in words from a list.
 * What a network said, and what went wrong in pigy, goes to the log and
 * not into an address.
 */
export function connectCallbackRoutes(
  dependencies: AppDependencies,
): Hono<AppEnv> {
  const { fetch, now, developmentCredentialKeys } = dependencies;
  const app = new Hono<AppEnv>();

  app.get("/:network/callback", async (c) => {
    const network = networkSchema.safeParse(c.req.param("network")).data;
    // The workspace that the connection is for, once that is known.
    let workspaceId: string | undefined;
    /** Sends the browser to the app, which shows how the connection ended. */
    const back = (connect: ConnectResult, channel?: string) => {
      const outcome = {
        connect,
        ...(network && { network }),
        ...(workspaceId && { workspace: workspaceId }),
        ...(channel && { channel }),
      } satisfies ConnectOutcome;
      return c.redirect(`${connectReturnPath}?${new URLSearchParams(outcome)}`);
    };
    try {
      if (!network) return back("failed");

      const session = await authenticateWithCookie(c, dependencies);
      const state = c.req.query("state");
      // Nothing is looked up for somebody who is not signed in. They are
      // sent to the same page as everybody: the app has them sign in
      // first, and then says that the connection has to be begun again.
      if (!session || !state) return back("expired");

      const url = new URL(c.req.url);
      const vault = vaultFor(c.env, developmentCredentialKeys, url.origin);
      if (!vault) return back("failed");

      const db = drizzle(c.env.DB);
      const flow = await takePending(
        db,
        vault,
        state,
        session.sessionId,
        now(),
      );
      // The network named in the address is the one that was asked: the
      // callback of one network must not be finished by the adapter of
      // another.
      if (!flow || flow.network !== network) return back("expired");

      const workspace = await ownWorkspace(
        db,
        flow.workspaceId,
        session.auth.user.id,
      );
      if (!workspace) return back("expired");
      workspaceId = workspace.id;

      const connection = providerOf(network, workspace, {
        env: c.env,
        fetch,
        now,
        vault,
      });
      if (!connection) return back("failed");

      const { account, access } = await connection.provider.completeConnect({
        pending: flow.pending,
        params: url.searchParams,
      });
      const channel = {
        network,
        ...channelOf(account, access.expiresAt, connection.reach, now()),
      };
      const stored = await connectChannel(c.env.WORKSPACE, workspace, channel, {
        credentials: await vault.seal(
          credentialsContext(workspace, channel),
          access.credentials,
        ),
        refreshAt: access.refreshAt?.getTime() ?? null,
      });
      if (!stored.ok) {
        console.error(`A channel was not stored: ${stored.message}`);
        return back("failed");
      }
      return back("connected", stored.channelId);
    } catch (error) {
      // Whatever fails, and wherever: the database while it is asked who
      // this is, a key that is gone, the network, the workspace. The
      // person ends on a page of the app, and the log says why.
      if (error instanceof ProviderError && error.declined) {
        return back("cancelled");
      }
      if (error instanceof ProviderError || error instanceof VaultError) {
        // Their messages hold no secret.
        console.warn(`A connection could not be finished: ${error.message}`);
      } else {
        // Without the values of a query that failed: the `state` of this
        // callback is one of them.
        console.error("A connection could not be finished", loggable(error));
      }
      return back("failed");
    }
  });

  return app;
}
