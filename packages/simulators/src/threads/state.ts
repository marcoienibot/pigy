import type {
  SimAccount,
  SimPost,
  SimToken,
  SimWorld,
  Table,
} from "../world/index.ts";

/** Somebody with a profile on the simulated Threads. */
export type ThreadsUser = SimAccount & {
  network: "threads";
  /** What the profile is found under, without the `@`. */
  username: string;
};

/**
 * An app as a developer has made it in Meta's dashboard, with the Threads
 * use case: there is no API to register one.
 */
export type ThreadsApp = {
  /** The Threads app ID, which is not the ID of the Meta app around it. */
  appId: string;
  appSecret: string;
  /** What the consent page calls it. */
  name: string;
  /** The redirect addresses that were entered for it, each in full. */
  redirectUris: string[];
  /** The permissions that were added to its use case. */
  scopes: string[];
};

export type ThreadsToken = SimToken & {
  network: "threads";
  /**
   * What a code is exchanged for lasts an hour, and what that is exchanged
   * for lasts 60 days and can be renewed.
   */
  kind: "short" | "long";
  /** In milliseconds since the epoch. */
  createdAt: number;
};

export type ThreadsPost = SimPost & {
  network: "threads";
  /** The part of the address of the post that names it. */
  shortcode: string;
  /**
   * What the post has besides its text, for one that a person made in
   * the app of Threads: the API of this simulation makes posts of plain
   * text, which have none of these.
   */
  media?: "IMAGE" | "VIDEO" | "CAROUSEL_ALBUM";
  quote?: boolean;
  poll?: boolean;
};

/**
 * What a post is made from: Threads publishes in two steps, and this is
 * what the first one makes.
 */
export type Container = {
  id: string;
  userId: string;
  text: string;
  replyToId: string | null;
  /** In milliseconds since the epoch. */
  createdAt: number;
  /** Until when Threads is busy preparing it, in milliseconds since the epoch. */
  readyAt: number;
  /** The post that it was published as, once it was. */
  publishedAs: string | null;
};

/** What a person consented to, until it is exchanged for a token. */
export type Code = {
  appId: string;
  userId: string;
  redirectUri: string;
  scopes: string[];
  /** In milliseconds since the epoch. */
  expiresAt: number;
};

/** The state of the simulated Threads, all of it in the world. */
export type State = {
  world: SimWorld;
  users: Table<ThreadsUser>;
  apps: Table<ThreadsApp>;
  codes: Table<Code>;
  containers: Table<Container>;
  posts: Table<ThreadsPost>;
  /**
   * When an account did what Threads counts, by what and whom: each time
   * in milliseconds since the epoch, for as long as it counts.
   */
  usage: Table<number[]>;
};

export function createState(world: SimWorld): State {
  return {
    world,
    users: world.accounts("threads"),
    apps: world.table("threads", "app"),
    codes: world.table("threads", "code"),
    containers: world.table("threads", "container"),
    posts: world.posts("threads"),
    usage: world.table("threads", "usage"),
  };
}

const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;

/** How long an authorization code lasts: an hour, as documented. */
export const codeLifetimeMs = hourMs;
/** How long a short-lived token lasts: an hour, as documented. */
export const shortLifetimeMs = hourMs;
/** How long a long-lived token lasts, from when it was made or renewed. */
export const longLifetimeMs = 60 * dayMs;
/** How old a long-lived token has to be before it can be renewed. */
export const renewableAfterMs = dayMs;
/** After how long a container that was not published expires. */
export const containerLifetimeMs = dayMs;
/** The time over which Threads counts what an account does. */
export const quotaWindowMs = dayMs;

/** How many of each an account may do within `quotaWindowMs`. */
export const quotas = {
  /** Posts that reply to nothing. Documented. */
  post: 250,
  /** Replies. Documented. */
  reply: 1000,
  /** Deletions. Documented. */
  delete: 100,
} as const;

export type Quota = keyof typeof quotas;

/**
 * The times within the window at which `userId` did what `quota` counts.
 */
export function usageOf(state: State, quota: Quota, userId: string): number[] {
  const from = state.world.now().getTime() - quotaWindowMs;
  return (state.usage.get(`${quota}/${userId}`) ?? []).filter(
    (time) => time > from,
  );
}

/** Counts one more of `quota` for `userId`, now. */
export function use(state: State, quota: Quota, userId: string): void {
  state.usage.put(`${quota}/${userId}`, [
    ...usageOf(state, quota, userId),
    state.world.now().getTime(),
  ]);
}

/**
 * A new ID, as the Graph API has them for everything: a long number. The
 * IDs of a world grow, so that what was made later sorts later.
 */
export function nextId(world: SimWorld): string {
  return String(1_784_140_000_000_000 + world.nextNumber());
}

/** The scopes of a list as Threads takes one: separated by commas. */
export function parseScopes(value: string): string[] {
  // GUESS: spaces are taken too, as OAuth has them.
  return value.split(/[,\s]+/).filter(Boolean);
}
