import { ProviderError } from "@pigy/providers";
import { openCredentials, sealCredentials } from "../channels/credentials.ts";
import type { AppDependencies, Bindings } from "../env.ts";
import { loggable } from "../errors.ts";
import { blueskyKeysWithoutRequest } from "../network/bluesky-client.ts";
import { cannotRenew, type providerOf } from "../network/providers.ts";
import { VaultError, vaultWithoutRequest } from "../vault.ts";
import type {
  DueRenewal,
  RenewedChannelAccess,
  WorkspaceIdentity,
} from "./store.ts";

/**
 * Renewing the access of a channel when the time has come that its
 * adapter named, whether or not anybody posts to the channel: what
 * `Access.refreshAt` of `@pigy/providers` asks of a caller. The alarm of
 * a workspace's object does it, `alarm` in object.ts, which is what calls
 * this.
 *
 * It is the second thing that refreshes a channel. The first is a
 * delivery whose step the network refuses, in src/publish/workflow.ts.
 * The two take turns, because some networks end the credentials that a
 * refresh starts from: the object begins the deliveries and renews by its
 * timer in the one alarm, one after the other, and it renews no channel
 * that a delivery is under way to.
 */

/** What the object of a workspace renews an access with. */
export type RenewalDependencies = Pick<
  AppDependencies,
  "fetch" | "now" | "developmentCredentialKeys" | "developmentBlueskyClientKeys"
> & {
  /** Makes the adapter of a network for a workspace. */
  providerOf: typeof providerOf;
};

/**
 * How long the object waits before it asks a network again that was out
 * of reach or in trouble, in milliseconds, unless the network names a
 * later time. An access is renewed weeks before it ends, so there is time
 * for many of these.
 */
export const renewalRetryMs = 60 * 60 * 1000;

/**
 * How long it waits after a failure that is no word of a network about
 * the access: this pigy lacks a key, or something in it is broken. Trying
 * again soon would fail again, and never trying again would lose an
 * access that a deploy could have saved.
 */
export const renewalBrokenMs = 24 * 60 * 60 * 1000;

/** What came of renewing the access of a channel. */
export type Renewal =
  | {
      kind: "renewed";
      /** What to store in place of the access that was renewed, sealed. */
      access: RenewedChannelAccess;
      /**
       * Gives the renewed access back to its network, where every
       * connection has an access of its own: for when the channel turns
       * out to hold another by now, or to be gone, and nothing would
       * hold what the refresh returned. It never fails.
       */
      discard(): Promise<void>;
    }
  /** The network will not renew: the account has to be connected again. */
  | { kind: "lapsed" }
  /** Not now. Try again at `at`, in milliseconds since the epoch. */
  | { kind: "later"; at: number }
  /** The access of this channel is not one that is renewed. */
  | { kind: "never" };

/**
 * Renews the access that `channel` of `workspace` holds, at its network.
 * It never fails: what goes wrong is what it returns, and is logged here,
 * without a secret.
 */
export async function renewAccess(
  {
    fetch,
    now,
    developmentCredentialKeys,
    developmentBlueskyClientKeys,
    providerOf,
  }: RenewalDependencies,
  env: Bindings,
  workspace: WorkspaceIdentity,
  channel: DueRenewal,
): Promise<Renewal> {
  const later = (milliseconds: number): Renewal => ({
    kind: "later",
    at: now().getTime() + milliseconds,
  });
  const of = `the ${channel.network} channel ${channel.channelId}`;
  try {
    const vault = vaultWithoutRequest(env, developmentCredentialKeys);
    // Nothing opens without the keys, which only whoever runs this pigy
    // can bring back.
    if (!vault) return later(renewalBrokenMs);
    // Renewing an access to Bluesky is signed with them.
    const blueskyClientKeys = blueskyKeysWithoutRequest(
      env,
      developmentBlueskyClientKeys,
    );
    const connection = providerOf(channel.network, workspace, {
      env,
      fetch,
      now,
      vault,
      blueskyClientKeys,
    });
    const provider = connection?.provider;
    if (!provider?.refresh) return { kind: "never" };
    // A secret of this pigy's that the renewal takes is missing. The
    // adapter would say that the account has to be connected again, as
    // it does of a key that was replaced, but nothing was asked of the
    // network and nothing is spent there: the access is renewed when
    // the secret is back.
    const missing = cannotRenew(channel.network, { blueskyClientKeys });
    if (missing) {
      console.warn(`The access of ${of} was not renewed: ${missing}`);
      return later(renewalBrokenMs);
    }

    let renewed: Awaited<ReturnType<typeof provider.refresh>>;
    try {
      renewed = await provider.refresh(
        await openCredentials(vault, workspace, channel, channel.credentials),
      );
    } catch (error) {
      if (error instanceof VaultError) {
        // Sealed with a key that is gone: a new connection stores new
        // ones. Its message holds no secret.
        console.warn(`The access of ${of} did not open: ${error.message}`);
        return { kind: "lapsed" };
      }
      if (!(error instanceof ProviderError)) throw error;
      console.warn(`The access of ${of} was not renewed: ${error.message}`);
      switch (error.kind) {
        case "reconnect":
          return { kind: "lapsed" };
        case "retry":
          return {
            kind: "later",
            at: Math.max(
              now().getTime() + renewalRetryMs,
              error.retryAt?.getTime() ?? 0,
            ),
          };
        // A refresh has nothing to renew first and publishes nothing, so
        // these two are no answers of one. Whatever the network meant,
        // it has not said that the access is over.
        case "refresh":
        case "uncertain":
        case "fail":
          return later(renewalBrokenMs);
      }
    }
    const access: RenewedChannelAccess = {
      credentials: await sealCredentials(
        vault,
        workspace,
        channel,
        renewed.credentials,
      ),
      refreshAt: renewed.refreshAt?.getTime() ?? null,
      expiresAt: renewed.expiresAt?.getTime() ?? null,
    };
    return {
      kind: "renewed",
      access,
      async discard() {
        if (!provider.accessPerConnection) return;
        try {
          await provider.disconnect(renewed.credentials);
        } catch (error) {
          console.warn(
            `A renewed access of ${of} that nothing holds was not given back`,
            error instanceof ProviderError ? error.message : loggable(error),
          );
        }
      },
    };
  } catch (error) {
    // A failure of pigy's own. On a network whose refresh ends what it
    // started from, the access may be lost with it.
    console.error(`The access of ${of} was not renewed`, loggable(error));
    return later(renewalBrokenMs);
  }
}
