import type { Limits, Network, PostContent } from "@pigy/core";
import { z } from "zod";

/**
 * The contract between pigy and a network. Every adapter implements
 * `Provider`, and callers know nothing of a network beyond it. PLAN.md
 * section 6 says how each of the four networks maps onto it.
 *
 * An adapter is made by a function of its own, which takes what the adapter
 * needs from outside: always `fetch` and the clock, and whatever is the
 * network's own, such as the registration of the operator's app. It keeps
 * nothing between calls. What has to last is handed to the caller, as JSON
 * that only the adapter understands, and comes back as an argument.
 *
 * Every method fails with a `ProviderError`, which says what to do next.
 */

/** A value that `JSON.stringify` and `JSON.parse` give back unchanged. */
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

const jsonSchema: z.ZodType<Json> = z.json();

/** Whose account a channel is, for display. */
export type Account = {
  /**
   * The network's own, permanent ID of the account. Unique within the
   * network, so two channels with the same ID are the same account.
   */
  id: string;
  /** How the network addresses the account, such as "@ada@mastodon.example". */
  handle: string;
  /** The name the person goes by. */
  name: string;
  /** A picture of the account, or null. Always an HTTPS address. */
  avatarUrl: string | null;
  /** The account's page on the network, or null. Always an HTTPS address. */
  profileUrl: string | null;
};

/**
 * What lets pigy act for an account, and how long it lasts.
 *
 * `credentials` are opaque: the caller stores them, encrypted, and hands
 * them back unchanged. The adapter checks them against its own schema each
 * time, so it never trusts what storage returns.
 */
export type Access = {
  credentials: Json;
  /**
   * When to call `refresh` and store what it returns. Null if there is
   * nothing to refresh.
   *
   * The caller sets a timer for this time. Refreshing only before the
   * credentials are next used is not enough: on some networks an access
   * that is not renewed in time is lost, so the account of somebody who
   * posts nothing for a while would have to be connected again.
   * `Provider.refresh` has the rules.
   */
  refreshAt: Date | null;
  /**
   * When the access ends unless it is refreshed before. If the network
   * cannot refresh, this is when the person has to connect again, and the
   * time to warn them ahead of. Null if no end is known.
   */
  expiresAt: Date | null;
};

/** What starts a connection. */
export type ConnectRequest = {
  /**
   * Where the network sends the browser afterwards: pigy's callback address
   * for this network, as registered with it.
   */
  redirectUri: string;
  /**
   * What the person typed to say where their account lives, on networks
   * that have no single place to sign in: the domain of the instance on
   * Mastodon, the handle on Bluesky. It is untrusted, and the adapter
   * checks it. Left out on the other networks.
   */
  identifier?: string | undefined;
};

/** A connection that has begun. */
export type ConnectStart = {
  /** Where to send the browser. */
  url: string;
  /**
   * The value the network sends back to the callback as `state`: the key
   * to keep `pending` under.
   */
  state: string;
  /**
   * What `completeConnect` needs. It holds secrets, so it is kept on the
   * server, for the few minutes a person takes to consent.
   */
  pending: Json;
};

/** What the network sent to the callback address. */
export type ConnectCallback = {
  /** What `beginConnect` returned, found by the `state` in `params`. */
  pending: Json;
  /** The query parameters of the callback address. */
  params: URLSearchParams;
};

/** One part of a post as it stands on the network. */
export const publishedPartSchema = z.strictObject({
  /**
   * The network's ID of the post that the part is in. Opaque: it is good
   * for `readPost` and `deletePost`. Parts that the network joins into one
   * post share its ID.
   */
  id: z.string().min(1),
  /** A link to the post for people, or null. Always an HTTPS address. */
  url: z.string().nullable(),
});

export type PublishedPart = z.infer<typeof publishedPartSchema>;

/**
 * How far the publishing of a post has come. Plain JSON, so that it can be
 * the recorded result of a step of a workflow and the starting point of the
 * next.
 */
export const publishProgressSchema = z.strictObject({
  /**
   * The parts that are published, in the order of the content. A part that
   * is listed here is never sent again.
   */
  parts: z.array(publishedPartSchema),
  /** True once every part is published. There is no step after that. */
  done: z.boolean(),
  /**
   * How long to wait before the next step, in seconds. 0 unless the network
   * needs time for what the last step started.
   */
  waitSeconds: z.number().nonnegative(),
  /** The adapter's own notes from one step to the next. Opaque. */
  state: jsonSchema,
});

export type PublishProgress = z.infer<typeof publishProgressSchema>;

/** One step of publishing. */
export type PublishRequest = {
  credentials: Json;
  /**
   * What to publish. It has passed `validateContent` of `@pigy/core`: a
   * step sends what it is given and leaves the judgement to the network.
   * The same content is passed to every step of a post.
   */
  content: PostContent;
  /**
   * What names this delivery, the same for every step and every attempt:
   * the ID of the target. Networks that can recognize a repeated request
   * are told apart by it, so a second delivery of the same post needs
   * another key.
   */
  key: string;
  /** What the step before returned, or null for the first step. */
  progress: PublishProgress | null;
};

/** A post, read back from the network. */
export type RemotePost = {
  id: string;
  /** A link to the post for people, or null. Always an HTTPS address. */
  url: string | null;
  /**
   * The text as the network shows it, without markup. That is not always
   * the text that was sent: a network may shorten a mention or a link.
   */
  text: string;
  /** The ID of the post that this one replies to, or null. */
  replyToId: string | null;
};

export type Provider = {
  readonly network: Network;

  /**
   * Starts connecting an account: works out where to send the person. The
   * caller redirects the browser to `url` and keeps `pending` until the
   * network sends the browser back.
   */
  beginConnect(request: ConnectRequest): Promise<ConnectStart>;

  /**
   * Finishes a connection with what the network sent to the callback
   * address.
   *
   * It is called once for a callback and cannot be tried again: the code
   * in the callback is good for one exchange, and a call that failed may
   * have spent it. So it fails with `fail` whatever went wrong, also when
   * the network was only out of reach. The caller then drops `pending`,
   * and whoever wants the account connected after all begins again, with
   * `beginConnect`. It fails the same way if the person declined or the
   * callback is not the answer to `pending`.
   */
  completeConnect(
    callback: ConnectCallback,
  ): Promise<{ account: Account; access: Access }>;

  /**
   * Renews the access without the person. Only networks that can do this
   * have the method, and only their `Access` has a `refreshAt`. It fails
   * with `reconnect` when the network will not renew: the channel then
   * needs connecting again.
   *
   * The caller calls it on two occasions, and stores what it returns:
   *
   * - When `refreshAt` has come, by a timer, whether or not the
   *   credentials are in use.
   * - At once, when a method failed with `refresh`, whatever `refreshAt`
   *   says. A network can refuse credentials before their time: its clock
   *   differs from pigy's, or they were replaced while the method ran. The
   *   caller then runs the method again with the new credentials. If the
   *   method fails with `refresh` once more, with credentials that a
   *   refresh has just returned, that is a `reconnect`.
   *
   * One refresh at a time per account: on some networks a refresh ends
   * the credentials it started from, and a second one that starts from the
   * same would lock the account out. A caller that is asked to refresh
   * credentials which are no longer the stored ones does not refresh. It
   * goes on with the stored ones, which another refresh has put there.
   */
  refresh?(credentials: Json): Promise<Access>;

  /**
   * Gives the access back, on networks that have a way: afterwards the
   * credentials are worthless. Disconnecting must not depend on it. A
   * caller removes the channel also when this fails.
   */
  disconnect(credentials: Json): Promise<void>;

  /**
   * What the account may post. Asked of the network where the answer
   * depends on the account or its server, so it is fetched when an account
   * is connected and again from time to time. `validateContent` of
   * `@pigy/core` checks content against the result.
   */
  limits(credentials: Json): Promise<Limits>;

  /**
   * Takes the publishing of a post one step further and returns how far it
   * has come. A step makes at most one request that changes something on
   * the network.
   *
   * The caller records the result before it runs the next step, and runs
   * steps until `done`. A step that failed with `retry` is run again with
   * the same request. That never publishes anything twice, also when the
   * failed attempt did reach the network and only its answer was lost.
   * After `fail`, the parts in the last recorded progress stay published,
   * and a later attempt starts from that progress.
   *
   * `publish` in publish.ts is this loop.
   */
  publishStep(request: PublishRequest): Promise<PublishProgress>;

  /**
   * The post with this ID, or null if the network has none. Only networks
   * that let pigy read posts have the method.
   */
  readPost?(credentials: Json, id: string): Promise<RemotePost | null>;

  /** Deletes the post with this ID. A post that is gone already is fine. */
  deletePost(credentials: Json, id: string): Promise<void>;
};
