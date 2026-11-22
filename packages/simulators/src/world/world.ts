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
};

export type SimWorldOptions = {
  /** Where the world is kept. In memory, if left out. */
  storage?: SimStorage;
  /** The clock that the world's time starts from and runs with. */
  now: Clock;
};

export function createWorld({
  storage = memoryStorage(),
  now,
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
  };
  return world;
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
