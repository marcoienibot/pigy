import { type Clock, type Network, networks } from "@pigy/core";
import { createFaults, type Faults } from "./faults.ts";
import { createBlobs, type SimBlobs, type SimImageType } from "./images.ts";
import { isSimulatedSecret, simulatedSecret } from "./secrets.ts";
import {
  memoryStorage,
  type SimStorage,
  type Table,
  table,
} from "./storage.ts";

/**
 * A simulated world: the accounts, tokens and posts of the simulated
 * networks, as one person sees them. Everything a simulator knows is in the
 * world's storage, and a simulator keeps nothing else, so one can be made
 * anew for every request.
 *
 * The world holds what all networks have in common, in one form, so that
 * the tools around the simulators are written once: listing what was
 * published, arming a fault, moving the clock. A network's simulator adds
 * what is its own: more fields on these records, and tables of its own.
 */

/** Somebody who has an account on a simulated network. */
export type SimAccount = {
  network: Network;
  /** Unique within the network. */
  id: string;
  /** How the network addresses the account. */
  handle: string;
  name: string;
};

/** What a simulated network gave out to act for an account. */
export type SimToken = {
  network: Network;
  token: string;
  /** Whose it is. Null for a token that stands for a client alone. */
  accountId: string | null;
  /** The client it was issued to. */
  clientId: string;
  scopes: string[];
  revoked: boolean;
  /**
   * When the token ends by itself, in milliseconds since the epoch. Left
   * out or null for a token that lasts until it is taken back.
   */
  expiresAt?: number | null;
};

/** A post on a simulated network. */
export type SimPost = {
  network: Network;
  /** Unique within the network. */
  id: string;
  accountId: string;
  /**
   * The text as the network keeps it. That need not be the text that was
   * sent: Mastodon rewrites mentions and drops the whitespace around it.
   */
  text: string;
  /** The post that this one replies to. A thread is a chain of these. */
  replyToId: string | null;
  /** In milliseconds since the epoch. */
  createdAt: number;
  /** Where the post would be on the network. */
  url: string;
  /**
   * What the network shows in the text as more than text, in the order of
   * the text, as the network has it: found by itself, or told by whoever
   * posted. Left out for a post from before the simulators kept them.
   */
  entities?: SimEntity[];
  /** The card of a link that the network shows with the post, if any. */
  card?: SimCard | null;
  /**
   * The images of the post, in the order they are shown in. Left out for
   * a post without any.
   */
  images?: SimImage[];
  /**
   * What people did with the post that the world does not count by
   * itself: `engage` adds to it. Left out where nobody did anything.
   */
  engagement?: Partial<SimEngagement>;
};

/**
 * What people did with a post: liked it, shared it, replied to it, quoted
 * it and saw it. A network shows what it counts of these, by names of
 * its own.
 */
export type SimEngagement = {
  likes: number;
  reposts: number;
  replies: number;
  quotes: number;
  views: number;
};

/** A link, a mention or a hashtag in the text of a simulated post. */
export type SimEntity = {
  kind: "link" | "mention" | "hashtag";
  /** Where it stands in the text, in UTF-16 code units. */
  start: number;
  end: number;
  /**
   * What it leads to, as the network keeps it: the address of a link,
   * the ID of the account that is mentioned, the tag.
   */
  target: string;
};

/**
 * An image of a simulated post, as the network keeps it: what it found in
 * the bytes, what the image is said to show, and the name of the bytes in
 * `blobs` of the world.
 */
export type SimImage = {
  blob: string;
  type: SimImageType;
  width: number;
  height: number;
  /** In bytes. */
  size: number;
  /** What it shows, as whoever posted it said. Empty if they said nothing. */
  alt: string;
};

/** What a simulated network shows of the page that a link leads to. */
export type SimCard = { url: string; title: string; description: string };

export type SimWorld = {
  /** The time in the world: the clock it was made with, moved by `advance`. */
  now: Clock;
  /** Moves the world's time forward, for good. */
  advance(milliseconds: number): void;
  /** A number that the world has not given out before. */
  nextNumber(): number;
  faults: Faults;

  /**
   * The accounts, tokens and posts of a network. Its simulator may keep
   * records with more fields than these, and says so with the type.
   */
  accounts<Account extends SimAccount = SimAccount>(
    network: Network,
  ): Table<Account>;
  posts<Post extends SimPost = SimPost>(network: Network): Table<Post>;
  /**
   * Issues a token, with a value that is made here. There is no way to put
   * a token from elsewhere into a world. The tokens of the network whose
   * end has passed are forgotten then, revoked or not, so that a world does
   * not keep every token that it has issued.
   */
  issueToken<Token extends SimToken = SimToken>(
    fields: Omit<Token, "token" | "revoked">,
  ): Token;
  /** The token with this value, if the world issued it. */
  findToken<Token extends SimToken = SimToken>(
    network: Network,
    value: string,
  ): Token | undefined;
  /** The tokens of a network. */
  tokens<Token extends SimToken = SimToken>(network: Network): Token[];
  /**
   * Takes a token back. It stays on record, as revoked, until its end has
   * passed and the network issues another.
   */
  revokeToken(network: Network, value: string): void;
  /**
   * Ends a token now, as if its time were up. It stays on record until the
   * network issues another.
   */
  expireToken(network: Network, value: string): void;
  /**
   * Whether a token is still good: not taken back, and not past its end by
   * the clock of the world. One that is both says `revoked`.
   */
  tokenStatus(token: SimToken): "valid" | "revoked" | "expired";

  /** A table of the simulator of `network`, for what is the network's own. */
  table<Row>(network: Network, name: string): Table<Row>;

  /** The bytes of the images that were published in the world. */
  blobs: SimBlobs;

  /**
   * Adds to what people did with a post of `network`, as if somebody had
   * liked it, shared it and so on: for a test, which says how many.
   */
  engage(network: Network, postId: string, more: Partial<SimEngagement>): void;
  /**
   * What people did with `post`, a post of `network`, now: what `engage`
   * added, the posts of the world that reply to it, and, in a world with
   * an audience, what the audience did since the post was made. With
   * `nested`, the replies are all those below the post, the replies to
   * its replies among them, as a network counts them that counts a whole
   * thread under the post that begins it.
   */
  engagementOf(
    network: Network,
    post: SimPost,
    options?: { nested?: boolean },
  ): SimEngagement;
};

export type SimWorldOptions = {
  /** Where the world is kept. In memory, if left out. */
  storage?: SimStorage;
  /** The clock that the world's time starts from and runs with. */
  now: Clock;
  /**
   * Whether the posts of the world have an audience, which likes, shares,
   * answers, quotes and sees them by itself as time goes by, so that a
   * person in a sandbox sees the stats of a post move: `audienceOf`.
   * Without one, as in a test, a post gets only what `engage` gives it.
   */
  audience?: boolean;
};

export function createWorld({
  storage = memoryStorage(),
  now,
  audience = false,
}: SimWorldOptions): SimWorld {
  const offset = () => (storage.get("clock/offset") as number | undefined) ?? 0;
  const tokenTable = <Token extends SimToken>(network: Network) =>
    table<Token>(storage, `token/${network}`);

  const world: SimWorld = {
    now: () => new Date(now().getTime() + offset()),
    advance(milliseconds) {
      storage.put("clock/offset", offset() + milliseconds);
    },
    nextNumber() {
      const next = ((storage.get("sequence") as number | undefined) ?? 0) + 1;
      storage.put("sequence", next);
      return next;
    },
    faults: createFaults(storage),

    accounts: (network) => table(storage, `account/${network}`),
    posts: (network) => table(storage, `post/${network}`),
    issueToken<Token extends SimToken>(
      fields: Omit<Token, "token" | "revoked">,
    ) {
      // The type parameter only adds fields, so this is a Token.
      const token = {
        ...fields,
        token: simulatedSecret(),
        revoked: false,
      } as Token;
      const tokens = tokenTable<Token>(token.network);
      const now = world.now().getTime();
      for (const [value, issued] of tokens.entries()) {
        const end = issued.expiresAt ?? null;
        if (end !== null && end <= now) tokens.delete(value);
      }
      tokens.put(token.token, token);
      return token;
    },
    findToken<Token extends SimToken>(network: Network, value: string) {
      return isSimulatedSecret(value)
        ? tokenTable<Token>(network).get(value)
        : undefined;
    },
    tokens<Token extends SimToken>(network: Network) {
      return tokenTable<Token>(network).all();
    },
    revokeToken(network, value) {
      const token = world.findToken(network, value);
      if (token) tokenTable(network).put(value, { ...token, revoked: true });
    },
    expireToken(network, value) {
      const token = world.findToken(network, value);
      if (token) {
        tokenTable(network).put(value, {
          ...token,
          expiresAt: world.now().getTime(),
        });
      }
    },
    tokenStatus(token) {
      if (token.revoked) return "revoked";
      const end = token.expiresAt ?? null;
      return end !== null && world.now().getTime() >= end ? "expired" : "valid";
    },

    table: (network, name) => table(storage, `${network}/${name}`),
    blobs: createBlobs(storage, () => world.nextNumber()),

    engage(network, postId, more) {
      const posts = world.posts(network);
      const post = posts.get(postId);
      if (!post) throw new Error(`There is no post ${postId} on ${network}`);
      const before = post.engagement ?? {};
      const engagement: Partial<SimEngagement> = { ...before };
      for (const [name, count] of Object.entries(more) as [
        keyof SimEngagement,
        number,
      ][]) {
        engagement[name] = (before[name] ?? 0) + count;
      }
      posts.put(postId, { ...post, engagement });
    },

    engagementOf(network, post, { nested = false } = {}) {
      const given = post.engagement ?? {};
      const grown = audience
        ? audienceOf(post, world.now().getTime())
        : { likes: 0, reposts: 0, replies: 0, quotes: 0, views: 0 };
      const repliesTo = new Map<string, string[]>();
      for (const { id, replyToId } of world.posts(network).all()) {
        if (replyToId === null) continue;
        repliesTo.set(replyToId, [...(repliesTo.get(replyToId) ?? []), id]);
      }
      let answers = 0;
      const below = [post.id];
      for (let id = below.pop(); id !== undefined; id = below.pop()) {
        const replies = repliesTo.get(id) ?? [];
        answers += replies.length;
        if (nested) below.push(...replies);
      }
      return {
        likes: grown.likes + (given.likes ?? 0),
        reposts: grown.reposts + (given.reposts ?? 0),
        replies: grown.replies + (given.replies ?? 0) + answers,
        quotes: grown.quotes + (given.quotes ?? 0),
        views: grown.views + (given.views ?? 0),
      };
    },
  };
  return world;
}

const minuteMs = 60 * 1000;

/**
 * What the audience of a world has done with `post` by the time `now`.
 * It is worked out from the post and the time alone, so it is the same
 * whoever asks, and grows as a post does: from the first minutes, half
 * of it in the first hour, and less and less after a day. How far a post
 * reaches, between 10 and 59 likes in the end, follows from its ID, so
 * that two posts do not do the same. The first like comes within one to
 * seven minutes, so that a person who tries pigy in a sandbox sees the
 * stats move when pigy reads them ten minutes after the post went out,
 * and not at once. People see a post before they like it, and the views
 * come first.
 */
export function audienceOf(post: SimPost, now: number): SimEngagement {
  // FNV-1a, which spreads the IDs well enough for this.
  let seed = 0x811c9dc5;
  for (const character of post.id) {
    seed = Math.imul(seed ^ character.charCodeAt(0), 0x01000193) >>> 0;
  }
  const reach = 10 + (seed % 50);
  const minutes = Math.max(0, now - post.createdAt) / minuteMs;
  // Half of the likes in the first hour, and half of the views in the
  // first half hour.
  const likes = Math.floor((reach * minutes) / (minutes + 60));
  return {
    likes,
    reposts: Math.floor(likes / 4),
    replies: Math.floor(likes / 8),
    quotes: Math.floor(likes / 15),
    views: Math.floor((reach * 25 * minutes) / (minutes + 30)),
  };
}

/** A post with the account that made it. */
export type FeedEntry = { post: SimPost; account: SimAccount };

/**
 * What is published in a world, oldest first: on all networks, or on the
 * ones named. A post that was deleted is not in it.
 */
export function feed(
  world: SimWorld,
  only: readonly Network[] = networks,
): FeedEntry[] {
  return only
    .flatMap((network) =>
      world
        .posts(network)
        .all()
        .flatMap((post) => {
          const account = world.accounts(network).get(post.accountId);
          return account ? [{ post, account }] : [];
        }),
    )
    .sort(
      (a, b) =>
        a.post.createdAt - b.post.createdAt ||
        a.post.id.localeCompare(b.post.id),
    );
}

/**
 * What `post` shows as more than text, each as its kind, how it is written
 * in the text and what it leads to: for whoever reads a feed, and for a
 * test to compare.
 */
export function entitiesOf(
  post: SimPost,
): [kind: SimEntity["kind"], written: string, target: string][] {
  return (post.entities ?? []).map(({ kind, start, end, target }) => [
    kind,
    post.text.slice(start, end),
    target,
  ]);
}
