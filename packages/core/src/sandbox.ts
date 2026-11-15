import { z } from "zod";
import { type Network, networkSchema } from "./network/network.ts";

/**
 * What every sandbox starts with: the simulated networks of a new sandbox
 * workspace, for the Worker to create and for the app to offer.
 */

/**
 * The simulated Mastodon server of a sandbox. It is what a person enters as
 * their server when they connect a Mastodon account there. The name is
 * under `.example`, which no real server can have.
 */
export const sandboxMastodonDomain = "mastodon.example";

/**
 * The handles of the simulated Bluesky accounts of a sandbox. What a person
 * enters to connect one of them there. They are under `.test`, which
 * atproto sets aside for development and no real account can have.
 */
export const sandboxBlueskyHandles = [
  "ada.bsky.test",
  "grace.bsky.test",
  "alan.bsky.test",
] as const;

/** What a person enters in a sandbox, on a network that asks for something. */
export type SandboxIdentifier = {
  /** What the form has filled in. */
  value: string;
  /** What to enter, said next to the field. */
  hint: string;
  /**
   * What to tell a person who entered something that leads to `host`,
   * which the simulated world of the sandbox does not have.
   */
  elsewhere(host: string): string;
};

const blueskyHandles = sandboxBlueskyHandles
  .join(", ")
  .replace(/, ([^,]*)$/, " and $1");

/**
 * What to enter in a sandbox as the `identifier` of a `ConnectRequest`, for
 * each network that asks a person where their account lives. A sandbox
 * reaches nothing but its simulated world, whatever the internet has.
 */
export const sandboxIdentifiers: {
  readonly [Name in Network]?: SandboxIdentifier;
} = {
  mastodon: {
    value: sandboxMastodonDomain,
    hint: `${sandboxMastodonDomain} is the simulated server of the sandbox, and the only one it has.`,
    elsewhere: (host) =>
      `The sandbox has no server ${host}. Enter ${sandboxMastodonDomain}, its simulated server.`,
  },
  bluesky: {
    value: sandboxBlueskyHandles[0],
    hint: `The sandbox has three simulated accounts: ${blueskyHandles}.`,
    elsewhere: (host) =>
      `The sandbox has no account ${host}. Enter the handle of one of its simulated accounts: ${blueskyHandles}.`,
  },
};

/**
 * What a sandbox shows of its simulated world, and what a person can do to
 * it, for the pages that are there to try pigy out. The routes are under
 * `/api/sandbox` and name no workspace: they answer for the sandbox of
 * whoever is signed in, and for no other.
 *
 * - `GET /api/sandbox/feed` answers with a `SandboxFeed`: what is published
 *   in the world, by account.
 * - `GET /api/sandbox/faults` answers with `SandboxFaults`: the ways each
 *   simulated network can be made to fail, and the faults that are armed.
 * - `POST /api/sandbox/faults` takes a `SandboxFault` and arms it: the next
 *   request of that kind to the network fails that way, once. It answers
 *   with the `SandboxFaults` as they are then. A fault that the network
 *   does not have is refused with a 400 that names the field: `network`,
 *   `kind` or `operation`.
 * - `DELETE /api/sandbox/faults` disarms every fault, and answers with the
 *   `SandboxFaults` as they are then.
 */

/** A post on a simulated network, with the posts that reply to it. */
export type SandboxPost = {
  /** The network's ID of the post: the `remoteId` of a published part. */
  id: string;
  /** The text as the network keeps it. */
  text: string;
  /** When it was posted, in milliseconds since the Unix epoch. */
  createdAt: number;
  /** The replies of the same account, oldest first. A thread is a chain. */
  replies: SandboxPost[];
};

export const sandboxPostSchema: z.ZodType<SandboxPost> = z.strictObject({
  id: z.string().min(1),
  text: z.string(),
  createdAt: z.number().int().nonnegative(),
  get replies() {
    return z.array(sandboxPostSchema);
  },
});

/** Response of `GET /api/sandbox/feed`. */
export const sandboxFeedSchema = z.strictObject({
  /**
   * Every account of the simulated world, in the order of their networks
   * and handles, also the ones that have posted nothing.
   */
  accounts: z.array(
    z.strictObject({
      network: networkSchema,
      /**
       * The simulated network's own ID of the account. It is not the
       * `accountId` of a channel, which an adapter makes of it.
       */
      id: z.string().min(1),
      /**
       * How the network addresses the account: the `handle` of the channel
       * that the account is connected as, if it is connected.
       */
      handle: z.string().min(1),
      name: z.string(),
      /**
       * What the account has posted that replies to nothing of its own,
       * newest first: each is a post or the beginning of a thread.
       */
      posts: z.array(sandboxPostSchema),
    }),
  ),
});

export type SandboxFeed = z.infer<typeof sandboxFeedSchema>;

/** Body of `POST /api/sandbox/faults`: a fault to arm. */
export const sandboxFaultSchema = z.strictObject({
  network: networkSchema,
  /** One of the `kinds` of the network. */
  kind: z.string().min(1).max(50),
  /**
   * One of the `operations` of the network: the kind of request to strike.
   * Left out, the fault strikes the next request of any kind.
   */
  operation: z.string().min(1).max(50).optional(),
});

export type SandboxFault = z.infer<typeof sandboxFaultSchema>;

/** Response of the routes under `/api/sandbox/faults`. */
export const sandboxFaultsSchema = z.strictObject({
  /** The simulated networks of the sandbox. */
  networks: z.array(
    z.strictObject({
      network: networkSchema,
      /** The ways the network can be made to fail, such as "rate-limit". */
      kinds: z.array(z.string()),
      /** The kinds of request that a fault can strike, such as "publish". */
      operations: z.array(z.string()),
      /**
       * The faults that have yet to strike, the one that strikes first
       * first. `operation` is null for a fault that strikes any request.
       */
      armed: z.array(
        z.strictObject({ kind: z.string(), operation: z.string().nullable() }),
      ),
    }),
  ),
});

export type SandboxFaults = z.infer<typeof sandboxFaultsSchema>;
