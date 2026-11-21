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
 * Every failure that is a provider's to report is a `ProviderError`, which
 * says what to do next: what a network answered, a network that did not
 * answer, input that a method cannot work with.
 *
 * One thing more can come out of every method, unchanged: what the `fetch`
 * that the adapter was made with throws that is no failure of a network.
 * A `fetch` fails with a TypeError when no answer comes. `send` of http.ts
 * takes that, and a request whose time is up, for a network out of reach,
 * which is a `retry`. Whatever else `fetch` throws it passes on as it is:
 * a bug in what stands behind `fetch`, or a check there that refused, such
 * as the simulated world of a sandbox that turns out to be another
 * workspace's. The same goes for whatever else an adapter was made with,
 * such as the store of Mastodon's registrations: what that throws comes
 * back to the caller as it is.
 *
 * Such a failure is pigy's own. It is no `ProviderError` and has none of
 * the kinds, so a caller must not take it for an answer of the network, to
 * try again or to give up on. A caller logs it, and treats the call as one
 * that was cut off: whether a request went out is not known.
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
 * next. It is stored as it is, where everybody who can read the records of
 * a workflow reads it too. So there is never a secret in it.
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
  /**
   * The adapter's own notes from one step to the next. Opaque to the
   * caller, and no place for a secret: no token, no key, nothing that the
   * credentials hold. A step gets the credentials anew every time.
   */
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
   * Whether the provider tells what a delivery has published from what
   * another delivery to the same account has, by what the delivery
   * recorded before it published anything.
   *
   * True where a step finds its post by something that is the delivery's
   * alone, such as a key of the provider's own making that the network
   * keeps the post under. The recorded progress of such a delivery stays
   * good whatever goes to the account meanwhile, and it is the only way
   * to a part that landed unseen: a caller keeps it.
   *
   * False where a step looks through what the account has posted since
   * the delivery began, or cannot look at all. To such a provider a post
   * of a later delivery that reads the same is its own. A caller that
   * lets a delivery pass one that has failed and published no part drops
   * what the failed one recorded, so that it begins anew when it is tried
   * again: `publishStep` has the rule.
   */
  readonly tellsDeliveriesApart: boolean;

  /**
   * Whether every connection gets an access of its own: one that
   * `disconnect` ends for that connection, and for no other of the same
   * account.
   *
   * False where the network hands a new connection the access that the
   * account has with pigy already, as Mastodon gives out the token that
   * exists for the same registration, account and scopes. Giving the
   * access of one connection back there ends the others too.
   *
   * A caller goes by it when a connection was completed and its access
   * could not be kept: see `completeConnect`.
   */
  readonly accessPerConnection: boolean;

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
   * have spent it. So its `ProviderError` is a `fail` whatever went wrong,
   * also when the network was only out of reach. The caller then drops
   * `pending`, and whoever wants the account connected after all begins
   * again, with `beginConnect`. It fails the same way if the callback is
   * not the answer to `pending`, and if the person declined: that error
   * has `declined` set, so that the caller can tell a change of mind from
   * a failure.
   *
   * What is no failure of a network, but one of what the adapter was made
   * with, comes out of it as out of every method: as it is, and not as a
   * `fail`. The connection is over then too.
   *
   * What it returns is an access that stands at the network. A caller
   * that then fails to keep it, because its storage fails, say, holds the
   * only copy of what could end it. Where `accessPerConnection`, it gives
   * the access back with `disconnect` before it lets go of it: nobody
   * could later, and on a network that renews an access the session would
   * stand for as long as the network lets one. Where not, it must not:
   * the access may be the one that a connection from before goes on with,
   * and the same access is handed out the next time, so nothing is left
   * behind that the next connection does not hold.
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
   * steps until `done`: `publish` in publish.ts is this loop. After `fail`,
   * the parts in the last recorded progress stay published, and a later
   * attempt starts from that progress.
   *
   * A step is run again, with the same request, when its outcome is not
   * known: it failed with `retry`, or it was cut off before its result was
   * recorded. That can be at once or days later, when a person asks for
   * another try. The run before may have reached the network all the same,
   * so that only its answer was lost. This is what a provider guarantees
   * for it:
   *
   * 1. No request that publishes is made before the progress says that it
   *    is about to be. The progress a step is given holds what a later run
   *    needs to tell whether the request was carried out: where the
   *    account's posts stood, a key of the provider's own making. A step
   *    that does not find that in its progress sends nothing. It returns
   *    progress that holds it, which the caller records, and the step
   *    after that sends.
   * 2. A step whose progress says so takes itself for a second run, and
   *    settles what the first one did by asking the network, never by how
   *    long ago it was. It looks for what the first run would have
   *    published and takes that for its own, or it sends a request that
   *    the network carries out once, however often and however late it
   *    gets it. What a network remembers for an hour, or for ten minutes,
   *    is not such a request. So no part is published twice.
   * 3. A provider whose network offers neither cannot run such a step
   *    again safely. When a request of its that publishes ends without a
   *    clear answer, because none came or because the one that came leaves
   *    open whether the request was carried out, it fails with `uncertain`
   *    and never with `retry`. The caller ends the delivery there and asks
   *    a person to look. If they find nothing and ask for another try, the
   *    step is run again from the recorded progress, and sends. This does
   *    not cover a step that was cut off after its request went out: it
   *    never got to fail. The caller of such a provider has to keep a step
   *    that began and left no outcome from being run again by itself. No
   *    provider of this kind exists yet. The first settles how.
   *
   * Three things no provider can see to, so the caller does:
   *
   * - A step is run again only when the run before it is over. A request
   *   that is still on its way, or still being worked on, shows nowhere
   *   yet. So there is one run at a time per key, and after `retry` the
   *   caller waits: until the time the error names, and when it names
   *   none, longer than a network takes over a request.
   * - Deliveries to one account run one after the other. The first step
   *   of a delivery is run only when every delivery to the account that
   *   began before it has ended: it is done, or it has failed and will
   *   not be taken up again from its recorded progress. A provider tells
   *   what a delivery has published from everything else on the account
   *   by what its first step recorded. Where that is where the account's
   *   posts stood, two deliveries that begin together with the same first
   *   part record the same, and one takes the other's post for its own:
   *   it replies to it, and the post goes when either delivery is
   *   deleted. Such a provider cannot tell the two apart, and says so
   *   with `tellsDeliveriesApart`. Only a delivery of a provider that
   *   can, and one that has published a part, may be taken up from its
   *   recorded progress after another has gone to the account. The
   *   deliveries run one after the other for every provider all the
   *   same: a refresh is one at a time per account, and deliveries are
   *   what refreshes. pigy keeps to this per channel. An account that is
   *   connected as two channels, in two workspaces, is not covered:
   *   PLAN.md section 8 says what can happen then.
   * - What a person has deleted or changed on the network since is no
   *   longer what a step looks for, and may be published again.
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
