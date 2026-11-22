import type {
  FaultKind,
  SimAccount,
  SimPost,
  SimToken,
  SimWorld,
  Table,
} from "../world/index.ts";

/**
 * A server in a simulated world that hosts accounts: a PDS, in the terms of
 * atproto. Its accounts are authorized by `issuer`, which is the server
 * itself or an entryway in front of several.
 */
export type Pds = {
  /** Where it is reached. */
  host: string;
  /** The origin of the authorization server of its accounts. */
  issuer: string;
};

export type BlueskyAccount = SimAccount & {
  network: "bluesky";
  // `id` is the DID of the account.
  /** The handle as atproto writes it, without "@": "ada.bsky.test". */
  domain: string;
  /** The host of the PDS that keeps the account. */
  pds: string;
  /**
   * How the handle leads to the DID: by a TXT record in the DNS, by a file
   * that the host of the handle serves, or not at all. With "none" the
   * account claims a handle that does not point back to it.
   */
  resolution: "dns" | "https" | "none";
  /**
   * Whether the account has a profile: the record that holds its name and
   * picture. A new account has none.
   */
  profile: boolean;
};

/** A client as the authorization server has read it from its address. */
export type Client = {
  id: string;
  name: string | null;
  redirectUris: string[];
  scopes: string[];
  /** The public keys it authenticates with, as JWKs. */
  keys: Record<string, unknown>[];
  /** Whether it may ask for a refresh token. */
  refreshes: boolean;
};

/** An authorization request that was pushed, until a person answers it. */
export type PushedRequest = {
  id: string;
  issuer: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
  loginHint: string | null;
  /** The key that the client proved to hold, by its thumbprint. */
  dpopJkt: string;
  /** The key that the client authenticated with. */
  clientKid: string;
  clientJkt: string;
  /** In milliseconds since the epoch. */
  expiresAt: number;
};

/** What a person consented to, until it is exchanged for tokens. */
export type Code = {
  code: string;
  request: PushedRequest;
  /** The DID of the account that consented. */
  did: string;
  expiresAt: number;
  /** The session that the code was exchanged for, once it was. */
  sessionId: string | null;
};

/**
 * What a client holds for an account: the tokens of the moment, bound to
 * the key of the client and to the key of the session.
 */
export type Session = {
  id: string;
  issuer: string;
  did: string;
  clientId: string;
  clientKid: string;
  clientJkt: string;
  dpopJkt: string;
  scopes: string[];
  /** The tokens that are good now. A refresh replaces both. */
  accessToken: string;
  refreshToken: string;
  /** In milliseconds since the epoch: when it began. */
  createdAt: number;
  /** When its tokens were last issued. */
  refreshedAt: number;
  revoked: boolean;
};

export type BlueskyToken = SimToken & {
  network: "bluesky";
  kind: "access" | "refresh";
  sessionId: string;
};

/** A record of a repository, as the simulated PDS keeps a post. */
export type PostRecord = SimPost & {
  network: "bluesky";
  // `id` is the AT URI of the record.
  rkey: string;
  cid: string;
  /** The record as it was written. */
  record: Record<string, unknown>;
};

/**
 * A blob that an account has uploaded to its PDS: bytes under the hash of
 * themselves. `record` is the post that refers to it, or null while none
 * does.
 */
export type StoredBlob = {
  cid: string;
  accountId: string;
  /** The name of the bytes in the blobs of the world. */
  blob: string;
  /** As the upload named it. */
  mimeType: string;
  size: number;
  /** What the bytes are, as the PDS reads them. */
  width: number;
  height: number;
  /** In milliseconds since the epoch. */
  createdAt: number;
  record: string | null;
};

/** What a rate limit has counted since `start`. */
export type Counter = { start: number; points: number };

/** The state of the simulated Bluesky, all of it in the world. */
export type State = {
  world: SimWorld;
  servers: Table<Pds>;
  accounts: Table<BlueskyAccount>;
  posts: Table<PostRecord>;
  /** The blobs of the accounts, each under the DID and the hash. */
  blobs: Table<StoredBlob>;
  requests: Table<PushedRequest>;
  codes: Table<Code>;
  sessions: Table<Session>;
  /** The nonces that a server hands out, by host and span of time. */
  nonces: Table<string>;
  /** The IDs of the proofs and assertions that were used, with their end. */
  replays: Table<number>;
  /** The code challenges that were used, with the time until which they count. */
  challenges: Table<number>;
  counters: Table<Counter>;
  /**
   * The fault that strikes a request that does `operation`, if one is
   * armed. A request without a token has none to lose.
   */
  takeFault(
    operation: Operation,
    kinds: readonly BlueskyFaultKind[],
    hasToken: boolean,
  ): BlueskyFaultKind | undefined;
};

/** The faults that Bluesky can suffer from. */
export const blueskyFaultKinds = [
  "rate-limit",
  "server-error",
  "lost-response",
  "token-revoked",
  "token-expired",
] as const satisfies readonly FaultKind[];

export type BlueskyFaultKind = (typeof blueskyFaultKinds)[number];

/**
 * The requests that a fault can strike:
 *
 * - `identity`: finding an account: the DID of a handle and the document
 *   of a DID.
 * - `server`: what a server says about its OAuth.
 * - `authorize`: pushing an authorization request.
 * - `token`: exchanging a code for tokens, and renewing them.
 * - `revoke`: giving an access back.
 * - `profile`: reading the profile of an account.
 * - `publish`, `read` and `delete`: writing, reading and deleting a post.
 * - `stats`: asking the app view what people did with a post.
 */
export const blueskyOperations = [
  "identity",
  "server",
  "authorize",
  "token",
  "revoke",
  "profile",
  "publish",
  "read",
  "delete",
  "stats",
] as const;

export type Operation = (typeof blueskyOperations)[number];

export function createState(world: SimWorld): State {
  return {
    world,
    servers: world.table("bluesky", "pds"),
    accounts: world.accounts("bluesky"),
    posts: world.posts("bluesky"),
    blobs: world.table("bluesky", "blob"),
    requests: world.table("bluesky", "request"),
    codes: world.table("bluesky", "code"),
    sessions: world.table("bluesky", "session"),
    nonces: world.table("bluesky", "nonce"),
    replays: world.table("bluesky", "replay"),
    challenges: world.table("bluesky", "challenge"),
    counters: world.table("bluesky", "counter"),
    takeFault: (operation, kinds, hasToken) =>
      world.faults.take(
        "bluesky",
        operation,
        kinds.filter(
          (kind) =>
            hasToken || (kind !== "token-revoked" && kind !== "token-expired"),
        ),
      ) as BlueskyFaultKind | undefined,
  };
}

/** The account that a handle names, whether or not the handle resolves. */
export function accountByHandle(
  state: State,
  handle: string,
): BlueskyAccount | undefined {
  const wanted = handle.toLowerCase();
  return state.accounts.all().find(({ domain }) => domain === wanted);
}

/**
 * Deletes the rows of `table` that `expired` says have had their time.
 * What a simulator keeps for a while is forgotten when it writes to the
 * table again, so that a world does not grow with every request.
 */
export function forget<Row>(
  table: Table<Row>,
  expired: (row: Row, id: string) => boolean,
): void {
  for (const [id, row] of table.entries()) {
    if (expired(row, id)) table.delete(id);
  }
}

/** Ends a session: its tokens are refused from now on. */
export function revokeSession(state: State, session: Session): void {
  state.world.revokeToken("bluesky", session.accessToken);
  state.world.revokeToken("bluesky", session.refreshToken);
  state.sessions.put(session.id, { ...session, revoked: true });
}
