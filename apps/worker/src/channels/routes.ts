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
  sandboxIdentifiers,
  uuidv7,
} from "@pigy/core";
import {
  type Account,
  type Json,
  type Provider,
  ProviderError,
} from "@pigy/providers";
import { drizzle } from "drizzle-orm/d1";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { authenticateWithCookie, requireUser } from "../auth/guards.ts";
import type { AppDependencies, AppEnv } from "../env.ts";
import { InvalidField, loggable, parseJsonBody } from "../errors.ts";
import { blueskyKeysFor } from "../network/bluesky-client.ts";
import {
  cannotConnect,
  type ProviderContext,
  providerOf,
} from "../network/providers.ts";
import type { Reach } from "../network/reach.ts";
import { WorldHostMissing } from "../sim/world.ts";
import { clipped } from "../text.ts";
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
import { openCredentials, sealCredentials } from "./credentials.ts";
import { keepPending, takePending } from "./pending.ts";

/**
 * Connecting an account to a workspace and disconnecting it. @pigy/core has
 * the requests and the answers, in src/connect.ts.
 *
 * The credentials of a channel pass through here on their way from an
 * adapter to the workspace and back to an adapter. They are sealed and
 * opened by ./credentials.ts and by nothing here, and they are in no
 * answer and no log.
 */

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
 * What to tell a person who entered something that leads to `host`, which
 * the simulated world of their sandbox does not have: what to enter there
 * instead, where the network has something to enter.
 */
function notInSandbox(network: Network, host: string): string {
  return (
    sandboxIdentifiers[network]?.elsewhere(host) ??
    `The sandbox has no server ${host}.`
  );
}

/**
 * The host that the simulated world of a sandbox does not have, if that is
 * what `error` comes down to. An adapter may say more about it than that a
 * host could not be reached, such as that it found no account, and keeps
 * what it was among the causes of its error.
 */
function hostMissing(error: Error): WorldHostMissing | undefined {
  for (let cause: unknown = error.cause; cause; ) {
    if (cause instanceof WorldHostMissing) return cause;
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return undefined;
}

/** Under `/api`: starting a connection, and disconnecting. */
export function channelRoutes(dependencies: AppDependencies): Hono<AppEnv> {
  const {
    fetch,
    now,
    developmentCredentialKeys,
    developmentBlueskyClientKeys,
  } = dependencies;
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
    const context: ProviderContext = {
      env: c.env,
      fetch,
      now,
      vault,
      blueskyClientKeys: blueskyKeysFor(
        c.env,
        developmentBlueskyClientKeys,
        origin,
      ),
    };
    const connection = providerOf(network, workspace, context);
    if (!connection) {
      throw new InvalidField(
        "network",
        `pigy cannot connect accounts of ${network} yet.`,
      );
    }
    // A network that needs a secret of this pigy's, which it has not
    // been given.
    const missing = cannotConnect(network, connection.reach, context);
    if (missing) throw new HTTPException(503, { message: missing });

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
        const missing = hostMissing(error);
        if (missing) {
          throw new InvalidField(
            "identifier",
            notInSandbox(network, missing.host),
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
            blueskyClientKeys: blueskyKeysFor(
              c.env,
              developmentBlueskyClientKeys,
              origin,
            ),
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
 * then, or holds another access, and whoever disconnects is told whether
 * the access went with it.
 */
function giveBack(
  workspace: WorkspaceIdentity,
  access: StoredChannelAccess,
  context: ProviderContext,
): Promise<boolean> {
  return givenBack(async () => {
    if (access.credentials === null) return false;
    const connection = providerOf(access.network, workspace, context);
    if (!connection) return false;
    await connection.provider.disconnect(
      await openCredentials(
        context.vault,
        workspace,
        access,
        access.credentials,
      ),
    );
    return true;
  });
}

/**
 * Gives an access back to its network with `attempt`, and returns whether
 * that worked: `attempt` says no where there is nothing to give back
 * with. It never throws, and what it logs holds no secret: whoever lets
 * go of an access is told whether the network took it, and has nothing
 * else to do about it. The access is that of a channel that is gone, of a
 * connection that never became a channel, or one that a later connection
 * of its account has replaced.
 */
async function givenBack(attempt: () => Promise<boolean>): Promise<boolean> {
  try {
    return await attempt();
  } catch (error) {
    if (error instanceof ProviderError || error instanceof VaultError) {
      // Their messages hold no secret.
      console.warn(
        `An access was not given back to its network: ${error.message}`,
      );
    } else {
      console.error(
        "An access was not given back to its network",
        loggable(error),
      );
    }
    return false;
  }
}

/**
 * What the account that was just connected may post, or null if the network
 * does not say. It never throws: the account is connected by now, and a
 * channel without limits gets them when something is published to it.
 */
async function limitsOf(provider: Provider, credentials: Json) {
  try {
    return await provider.limits(credentials);
  } catch (error) {
    if (error instanceof ProviderError) {
      // Its message holds no secret.
      console.warn(`The limits of an account were not read: ${error.message}`);
    } else {
      console.error("The limits of an account were not read", loggable(error));
    }
    return null;
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
  const {
    fetch,
    now,
    developmentCredentialKeys,
    developmentBlueskyClientKeys,
  } = dependencies;
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

      const context: ProviderContext = {
        env: c.env,
        fetch,
        now,
        vault,
        blueskyClientKeys: blueskyKeysFor(
          c.env,
          developmentBlueskyClientKeys,
          url.origin,
        ),
      };
      const connection = providerOf(network, workspace, context);
      if (!connection) return back("failed");

      const { provider } = connection;
      // What is given back to the network on the way, each to its end and
      // none of them rejecting. The answer does not wait for them.
      const givingBack: Promise<boolean>[] = [];
      const connecting = (async () => {
        const { account, access } = await provider.completeConnect({
          pending: flow.pending,
          params: url.searchParams,
        });
        // From here on the network has an access for pigy, and this
        // request holds the only copy of what could end it. If the channel
        // is not stored, for whatever reason, the access is given back
        // before the request lets go of it: nobody could later. On Bluesky
        // it is a session with a refresh token, which would stand at the
        // network for months with nobody to use it or to end it.
        //
        // Not where the network gives every connection of an account the
        // same access, as Mastodon does with its token: the account may
        // have a channel already, here or in another workspace, that goes
        // on with that token, and the next connection is handed it again,
        // so nothing is left behind. The adapter says which it is.
        const abandon = () => {
          if (!provider.accessPerConnection) return;
          givingBack.push(
            givenBack(async () => {
              await provider.disconnect(access.credentials);
              return true;
            }),
          );
        };
        try {
          const channel = {
            network,
            ...channelOf(account, access.expiresAt, connection.reach, now()),
            limits: await limitsOf(provider, access.credentials),
          };
          const sealed = {
            credentials: await sealCredentials(
              vault,
              workspace,
              channel,
              access.credentials,
            ),
            refreshAt: access.refreshAt?.getTime() ?? null,
          };
          // The call has a key, which no other call has: the ID that this
          // request made up for the channel. The workspace carries a call
          // with a key out once, so it can be repeated.
          const store = () =>
            connectChannel(c.env.WORKSPACE, workspace, channel, sealed, {
              key: `channel.connect/${channel.id}`,
              handBack: provider.accessPerConnection,
            });
          // A call that throws may have stored the channel all the same:
          // its answer can be lost on the way back. Giving the access back
          // then would end the session of a channel that says `connected`,
          // and on a reconnect that of a channel that worked a moment ago.
          // So the call is repeated, once: if the first one arrived, the
          // repeat is answered as it was and stores nothing, and if it did
          // not, the repeat is the call. Only when that fails too is the
          // access given back. A channel that was stored by a call whose
          // answer and whose repeat were both lost is left with an access
          // that is gone, and needs connecting again when it is next used:
          // that is accepted.
          const stored = await store().catch((error: unknown) => {
            console.error(
              "A channel was not stored at the first try",
              loggable(error),
            );
            return store();
          });
          if (!stored.ok) {
            abandon();
            return stored;
          }
          // The account had a channel, whose access this connection has
          // replaced, and nothing holds the earlier one any more. Where
          // every connection has an access of its own, it is given back:
          // it is a session that would stand at the network otherwise.
          // Never where connections share one, as on Mastodon: there it is
          // the access that the channel goes on with.
          if (stored.replaced && provider.accessPerConnection) {
            givingBack.push(giveBack(workspace, stored.replaced, context));
          }
          return stored;
        } catch (error) {
          abandon();
          throw error;
        }
      })();
      // From the exchange of the code on, the work goes to its end whether
      // or not anybody waits for the answer: the runtime drops what is left
      // of a request when its client goes away, unless it was asked to keep
      // it going. Somebody who closes the tab while the code is exchanged,
      // or while the channel is stored, would leave an access at the
      // network that was never stored and never given back. So the runtime
      // is asked before anything is awaited, as where a channel is
      // disconnected, and with a promise that never rejects, for the
      // reason given there. The runtime gives such work 30 seconds once
      // the client is gone.
      c.executionCtx.waitUntil(
        connecting.catch(() => {}).then(() => Promise.all(givingBack)),
      );

      const stored = await connecting;
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
