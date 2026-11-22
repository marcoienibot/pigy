import {
  type MutatorArgs,
  metricMoments,
  networkNames,
  targetLimits,
} from "@pigy/core";
import { ProviderError, postMetricsSchema } from "@pigy/providers";
import { openCredentials } from "../channels/credentials.ts";
import type { Bindings } from "../env.ts";
import { log } from "../log.ts";
import { blueskyKeysWithoutRequest } from "../network/bluesky-client.ts";
import { clipped } from "../text.ts";
import { VaultError, vaultWithoutRequest } from "../vault.ts";
import type { RenewalDependencies } from "./renewal.ts";
import type { DueMetrics, WorkspaceIdentity } from "./store.ts";

/**
 * Reading the stats of a delivery that is sent: what people did with the
 * post on its network. The alarm of a workspace's object does it, in a
 * pass of its own, `#metricsPass` in object.ts, at the moments of
 * `metricMoments` after the delivery was sent: PLAN.md section 14.
 *
 * It reads and changes nothing on the network, and renews no access, so
 * it can run beside a delivery and a renewal. Credentials are opened with
 * `openCredentials`, in the call and for the call, and the adapter is
 * made by `providerOf`, which gives a sandbox its simulated world.
 */

/** What the object reads the stats of a delivery with: what it renews with. */
export type MetricsDependencies = RenewalDependencies;

/**
 * How long the object waits before it asks a network again that asked to
 * be asked later, or was out of reach, in milliseconds, unless the network
 * names a later time.
 */
export const metricsRetryMs = 60 * 60 * 1000;

/**
 * How long it waits after a failure that is no word of a network: this
 * pigy lacks a key, or something in it is broken.
 */
export const metricsBrokenMs = 24 * 60 * 60 * 1000;

/**
 * How long after its last moment a read that was put off is still made, in
 * milliseconds. A read is put off for as long as its network asks, an hour
 * at a time, and the last one would be put off for good by a network that
 * keeps asking to be asked later.
 */
export const metricsGraceMs = 24 * 60 * 60 * 1000;

const dayMs = 24 * 60 * 60 * 1000;

/**
 * The next moment at which the stats of a delivery that was sent at
 * `sentAt` are read, after `time`, or null after the last. A moment that
 * passed while nothing read is left out: the next read is that of the
 * moment that is still ahead.
 */
export function nextMetricsMoment(sentAt: number, time: number): number | null {
  for (const after of metricMoments) {
    if (sentAt + after > time) return sentAt + after;
  }
  return null;
}

/** What came of reading the stats of a delivery. */
export type MetricsOutcome = {
  /** What to store with `metric.record`, or nothing. */
  reading: MutatorArgs<"metric.record"> | null;
  /**
   * When to read the stats of the delivery next, in milliseconds since the
   * epoch, or never with null.
   */
  next: number | null;
  /**
   * Until when its network is asked nothing more, where it asked to be
   * asked later or could not be reached: the other reads of the channel
   * wait until then, and the pass asks it nothing more. Apart from `next`,
   * which is never for a read that is given up, and is a moment after
   * this for one that is not: the reads that waited come first.
   */
  rest?: number;
};

/**
 * What a delivery says of its stats where pigy could not read them, and
 * has nothing better to say.
 */
const unreadReason = "pigy could not read the stats of this post.";

/**
 * Reads the stats of the delivery `due` of `workspace`, from the first
 * part that it published. It never fails: what goes wrong is what it
 * returns, and is logged here, without a secret.
 *
 * Every outcome reads again later, or stores what the stats are: a read
 * that is given up, or that cannot be made, says why, so that no delivery
 * is left without stats for good while the API says that they are yet
 * to come.
 */
export async function readMetrics(
  {
    fetch,
    now,
    developmentCredentialKeys,
    developmentBlueskyClientKeys,
    providerOf,
  }: MetricsDependencies,
  env: Bindings,
  workspace: WorkspaceIdentity,
  due: DueMetrics,
): Promise<MetricsOutcome> {
  const time = now().getTime();
  const { targetId, sentAt, remoteId, channel } = due;
  // The read after this one. Every outcome but a stop goes on to it or to
  // a time after it. Never the read at once again: the workspace runs a
  // mutation later than its clock where it runs several in a moment, so
  // the delivery can have been sent a little after the time of its read.
  const following = nextMetricsMoment(sentAt, Math.max(time, sentAt));
  const lastMoment = metricMoments.at(-1) ?? 0;
  /**
   * Stores that the stats are unavailable and why, which keeps what was
   * counted before, and reads again at `next`, or never with null.
   */
  const unavailable = (
    reason: string,
    next: number | null,
  ): MetricsOutcome => ({
    reading: {
      id: targetId,
      status: "unavailable",
      // A message of a network can be longer than a reason may be, or
      // empty, and `metric.record` would refuse it.
      reason: clipped(reason, targetLimits.errorLength) || unreadReason,
    },
    next,
  });
  /**
   * Reads again at `at`, unless that is past what is still read at all:
   * then the stats are given up, and say so in the words of `reason`.
   */
  const later = (at: number, reason: string): MetricsOutcome =>
    at > sentAt + lastMoment + metricsGraceMs
      ? unavailable(reason, null)
      : { reading: null, next: at };
  // A channel that is gone takes its access with it. What was read stays.
  if (!channel) {
    return unavailable(
      "The account was disconnected from pigy, which reads the stats of its posts no more.",
      null,
    );
  }
  const name = networkNames[channel.network];
  if (remoteId === null) {
    return unavailable(
      `pigy has no record of the post that this delivery made on ${name}.`,
      null,
    );
  }
  const where = {
    workspaceId: workspace.id,
    channelId: channel.channelId,
    targetId,
    network: channel.network,
  };
  try {
    const vault = vaultWithoutRequest(env, developmentCredentialKeys);
    // Nothing opens without the keys, which only whoever runs this pigy
    // can bring back.
    if (!vault) return later(time + metricsBrokenMs, unreadReason);
    const { provider } = providerOf(channel.network, workspace, {
      env,
      fetch,
      now,
      vault,
      blueskyClientKeys: blueskyKeysWithoutRequest(
        env,
        developmentBlueskyClientKeys,
      ),
    });
    // A network that has none for pigy is never asked, whatever becomes
    // of the account.
    if (!provider.metrics) {
      return unavailable(
        `${name} does not give pigy the stats of its posts.`,
        null,
      );
    }
    // Its network refuses its access: nothing to ask until it is
    // connected again, which the person has been told. The next moment
    // may find it so, and at the last there is none.
    if (channel.status === "needs_reconnect") {
      return following === null
        ? unavailable(
            `The account had to be connected again when pigy last looked for the stats of this post, ${lastMoment / dayMs} days after it was sent.`,
            null,
          )
        : unavailable(
            "The account has to be connected again: pigy reads its stats once it is.",
            following,
          );
    }
    let counts: Awaited<ReturnType<typeof provider.metrics>>;
    try {
      counts = await provider.metrics(
        await openCredentials(vault, workspace, channel, channel.credentials),
        remoteId,
      );
    } catch (error) {
      if (error instanceof VaultError) {
        // Its message holds no secret. A new connection stores
        // credentials that open, and the publishing of the next post
        // says so where it matters.
        log.warn(
          "stats",
          `The access of a channel did not open: ${error.message}`,
          where,
        );
        return later(time + metricsBrokenMs, unreadReason);
      }
      if (!(error instanceof ProviderError)) throw error;
      switch (error.kind) {
        // The network asks to be asked later, or could not be reached. A
        // refresh is not among what this asks for, and is left to the
        // timer of the access and to the next delivery, which renew.
        case "retry":
        case "refresh": {
          if (error.notShown) {
            // The network answered, and does not show this post, yet or
            // any more: it alone waits, for its next moment, and the
            // other reads of the channel go on. A post that the network
            // still does not show at the last moment never has stats.
            return following === null
              ? unavailable(error.message, null)
              : { reading: null, next: following };
          }
          // The channel rests until then, also where this read is given
          // up.
          const rest = Math.max(
            time + metricsRetryMs,
            error.retryAt?.getTime() ?? Number.NEGATIVE_INFINITY,
          );
          const { reading, next } = later(
            rest,
            `${name} did not answer for the stats of this post when pigy last asked, ${lastMoment / dayMs} days after it was sent.`,
          );
          return {
            reading,
            // A moment after the other reads of the channel, which wait
            // until then: a pass reads what was due first first, and a
            // network that fails for this post alone, as a server that
            // cannot build the page of one status, would refuse it again
            // and put them off once more, every time, for a month.
            next: next === null ? null : next + 1,
            rest,
          };
        }
        // The network gives no stats of this post with this access, and
        // says why. The channel is not marked for that: what publishing
        // would say of the access, publishing says. The next moment asks
        // again, which a new connection may have made good. At the last
        // there is none, and the words are pigy's: what the network said
        // can promise stats once the account is connected again.
        case "fail":
        case "reconnect":
        case "uncertain":
          return following === null
            ? unavailable(
                `${name} did not give pigy the stats of this post when it last asked, ${lastMoment / dayMs} days after it was sent.`,
                null,
              )
            : unavailable(error.message, following);
      }
    }
    if (counts === null) {
      return { reading: { id: targetId, status: "gone" }, next: null };
    }
    return {
      // What an adapter returns is checked as the contract has it.
      reading: {
        id: targetId,
        status: "counted",
        ...postMetricsSchema.parse(counts),
      },
      next: following,
    };
  } catch (error) {
    // A failure of pigy's own.
    log.error("stats", "The stats of a delivery were not read", where, error);
    return later(time + metricsBrokenMs, unreadReason);
  }
}
