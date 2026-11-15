import type {
  SimAccount,
  SimPost,
  SimToken,
  SimWorld,
  Table,
} from "../world/index.ts";

/** A Mastodon server in a simulated world. */
export type Instance = {
  /** Where it is reached, and what its accounts are addressed with. */
  domain: string;
  title: string;
  /**
   * The version of Mastodon it runs. Before 4.3 an instance has no OAuth
   * metadata, no PKCE and no `profile` scope.
   */
  version: string;
  /** The most characters in a status. Instances choose their own. */
  maxCharacters: number;
  /** What a link counts as. */
  charactersReservedPerUrl: number;
};

export type MastodonAccount = SimAccount & {
  network: "mastodon";
  /** The instance it lives on. */
  domain: string;
  username: string;
};

/** pigy, or any other client, as it registered with an instance. */
export type App = {
  id: string;
  domain: string;
  clientId: string;
  clientSecret: string;
  name: string;
  website: string | null;
  redirectUris: string[];
  scopes: string[];
};

export type MastodonToken = SimToken & {
  network: "mastodon";
  domain: string;
  /** In milliseconds since the epoch. */
  createdAt: number;
};

export type Visibility = "public" | "unlisted" | "private" | "direct";

export type Status = SimPost & {
  network: "mastodon";
  domain: string;
  visibility: Visibility;
  /** The client it was posted with. */
  appId: string;
};

/** What a person consented to, until it is exchanged for a token. */
export type Code = {
  code: string;
  clientId: string;
  accountId: string;
  redirectUri: string;
  scopes: string[];
  /** Null if the request had none. */
  codeChallenge: string | null;
  /** In milliseconds since the epoch. */
  expiresAt: number;
};

/** The status that a request with an idempotency key made. */
export type IdempotencyRecord = { statusId: string; expiresAt: number };

/** The state of the simulated Mastodon, all of it in the world. */
export type State = {
  world: SimWorld;
  instances: Table<Instance>;
  accounts: Table<MastodonAccount>;
  apps: Table<App>;
  codes: Table<Code>;
  statuses: Table<Status>;
  idempotency: Table<IdempotencyRecord>;
  /** How often something was done in the span of time it is counted for. */
  counters: Table<{ span: number; count: number }>;
  /**
   * A new ID in Mastodon's form: a number as a string, made of the time and
   * a counter, so that IDs made later are larger.
   */
  nextId(): string;
};

export function createState(world: SimWorld): State {
  return {
    world,
    instances: world.table("mastodon", "instance"),
    accounts: world.accounts("mastodon"),
    apps: world.table("mastodon", "app"),
    codes: world.table("mastodon", "code"),
    statuses: world.posts("mastodon"),
    idempotency: world.table("mastodon", "idempotency"),
    counters: world.table("mastodon", "counter"),
    nextId: () =>
      (
        (BigInt(world.now().getTime()) << 16n) |
        BigInt(world.nextNumber() & 0xffff)
      ).toString(),
  };
}

/** Whether `version` is at least `major.minor`. */
export function atLeast(version: string, major: number, minor: number) {
  const [a = 0, b = 0] = version
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  return a > major || (a === major && b >= minor);
}

/** The scopes that an instance knows, by its version. */
export function knownScopes(instance: Instance): string[] {
  return [
    ...(atLeast(instance.version, 4, 3) ? ["profile"] : []),
    "read",
    "read:accounts",
    "read:blocks",
    "read:bookmarks",
    "read:favourites",
    "read:filters",
    "read:follows",
    "read:lists",
    "read:mutes",
    "read:notifications",
    "read:search",
    "read:statuses",
    "write",
    "write:accounts",
    "write:blocks",
    "write:bookmarks",
    "write:conversations",
    "write:favourites",
    "write:filters",
    "write:follows",
    "write:lists",
    "write:media",
    "write:mutes",
    "write:notifications",
    "write:reports",
    "write:statuses",
    "follow",
    "push",
  ];
}
