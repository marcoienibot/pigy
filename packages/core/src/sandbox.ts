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
 * A page of the simulated web of every sandbox, for a link to try: a post
 * that leads to it gets a card. The simulated web has a few pages under
 * `.test`, which nothing on the internet can have, and `@pigy/simulators`
 * has them.
 */
export const sandboxLink = "https://example.test/";

/**
 * What a sandbox shows of its simulated world, and what a person can do to
 * it, for the pages that are there to try pigy out. The routes are under
 * `/api/sandbox` and name no workspace: they answer for the sandbox of
 * whoever is signed in, and for no other.
 *
 * - `GET /api/sandbox/feed?marks=1` answers with a `SandboxFeed`: what is
 *   published in the world, by account, each post with its links,
 *   mentions and hashtags as its network has them, and with the card of
 *   its link. Without the query, `sandboxFeedMarks`, the posts come
 *   without `entities` and `card`, as the feed was before phase 4b: the
 *   app of that time takes no field that it does not know, and a device
 *   runs the app that it has until it is next started there.
 *
 * The schemas of the answers here take a field that they do not know and
 * leave it out, as every schema of an answer that a client fetches does
 * from phase 4b on: the next field needs no such query. AGENTS.md, "Add
 * an API route", has the rule.
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
  /**
   * What the network shows in the text as more than text, in the order of
   * the text and none within another: each with where it stands, in
   * UTF-16 code units. It is what the simulated network made of the post,
   * by its own rules or as the post marked it.
   */
  entities: SandboxEntity[];
  /**
   * The card of a link that the network shows with the post, or null. Its
   * texts are what a page says of itself: text, never markup.
   */
  card: { url: string; title: string; description: string } | null;
  /** The replies of the same account, oldest first. A thread is a chain. */
  replies: SandboxPost[];
};

/** A link, a mention or a hashtag in the text of a `SandboxPost`. */
export type SandboxEntity = {
  kind: "link" | "mention" | "hashtag";
  start: number;
  end: number;
};

/**
 * The parameter of the query with which a client asks `/api/sandbox/feed`
 * for the `entities` and the `card` of each post.
 */
export const sandboxFeedMarks = "marks";

export const sandboxPostSchema: z.ZodType<SandboxPost> = z.object({
  id: z.string().min(1),
  text: z.string(),
  createdAt: z.number().int().nonnegative(),
  entities: z.array(
    z.object({
      kind: z.enum(["link", "mention", "hashtag"]),
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
    }),
  ),
  card: z
    .object({
      url: z.string(),
      title: z.string(),
      description: z.string(),
    })
    .nullable(),
  get replies() {
    return z.array(sandboxPostSchema);
  },
});

/** Response of `GET /api/sandbox/feed`. */
export const sandboxFeedSchema = z.object({
  /**
   * Every account of the simulated world, in the order of their networks
   * and handles, also the ones that have posted nothing.
   */
  accounts: z.array(
    z.object({
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
export const sandboxFaultsSchema = z.object({
  /** The simulated networks of the sandbox. */
  networks: z.array(
    z.object({
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
        z.object({ kind: z.string(), operation: z.string().nullable() }),
      ),
    }),
  ),
});

export type SandboxFaults = z.infer<typeof sandboxFaultsSchema>;
