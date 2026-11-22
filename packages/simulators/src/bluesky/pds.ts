import {
  gatewayError,
  json,
  jsonBody,
  lose,
  withFaults,
  xrpcError,
} from "./http.ts";
import { allowsRepo, authenticate, type Caller } from "./oauth.ts";
import { currentNonce } from "./proofs.ts";
import {
  accountOf,
  cidOf,
  isNsid,
  isRecordKey,
  isTid,
  nextTid,
  postCollection,
  postProblem,
  profileCollection,
  recordUri,
  shownOf,
} from "./record.ts";
import {
  type BlueskyToken,
  type Counter,
  type Operation,
  type Pds,
  type PostRecord,
  revokeSession,
  type State,
} from "./state.ts";

/**
 * The part of the HTTP API of a PDS that pigy uses: writing, reading and
 * deleting a record. Written from the "HTTP API (XRPC)" and "Repository"
 * specifications of atproto, the lexicons `com.atproto.repo.createRecord`,
 * `getRecord` and `deleteRecord` and `app.bsky.actor.profile`, and the
 * pages "Posts" and "Rate Limits" of https://docs.bsky.app.
 *
 * Where those leave a question open, the code of the PDS that Bluesky runs
 * was read, packages/pds of https://github.com/bluesky-social/atproto, and
 * what was taken from it is marked GUESS.
 *
 * Not simulated: the repository behind the records, with its commits and
 * signatures, every collection but posts and the profile, blobs, and the
 * limits that a PDS keeps per IP address.
 */

/** Where a post is shown to people: the address of Bluesky's own app. */
const postUrl = (did: string, rkey: string) =>
  `https://bsky.app/profile/${did}/post/${rkey}`;

// "Rate Limits": what an account may write, in points. Creating a record
// costs three, updating one two, deleting one one.
const writeLimits = [
  { name: "repo-write-hour", points: 5000, seconds: 60 * 60 },
  { name: "repo-write-day", points: 35_000, seconds: 24 * 60 * 60 },
];

type Limited = {
  limit: number;
  seconds: number;
  remaining: number;
  /** When the count begins anew, in milliseconds since the epoch. */
  resetAt: number;
  exceeded: boolean;
};

/**
 * Counts `points` against the limits of what the account `did` writes, and
 * returns where that leaves the limit that is closest. GUESS, from the
 * library that the reference server counts with: a span of time begins
 * with the first write in it.
 */
function consume(state: State, did: string, points: number): Limited {
  const now = state.world.now().getTime();
  const counted = writeLimits.map(({ name, points: limit, seconds }) => {
    const key = `${name}/${did}`;
    const stored = state.counters.get(key);
    const counter: Counter =
      stored && now < stored.start + seconds * 1000
        ? stored
        : { start: now, points: 0 };
    counter.points += points;
    state.counters.put(key, counter);
    return {
      limit,
      seconds,
      remaining: Math.max(0, limit - counter.points),
      resetAt: counter.start + seconds * 1000,
      exceeded: counter.points > limit,
    };
  });
  return counted.sort((a, b) => a.remaining - b.remaining)[0] as Limited;
}

/**
 * The headers that tell of a rate limit. GUESS, from the code of the
 * reference server: the documentation names the draft that they follow,
 * and the server writes the time of the reset as a time of day, in
 * seconds since the epoch, where the draft has the seconds that are left.
 */
function limitHeaders({ limit, seconds, remaining, resetAt }: Limited) {
  return {
    "RateLimit-Limit": String(limit),
    "RateLimit-Remaining": String(remaining),
    "RateLimit-Reset": String(Math.floor(resetAt / 1000)),
    "RateLimit-Policy": `${limit};w=${seconds}`,
  };
}

function tooManyRequests(state: State, limited: Limited): Response {
  const wait = Math.max(
    1,
    Math.ceil((limited.resetAt - state.world.now().getTime()) / 1000),
  );
  return xrpcError(429, "RateLimitExceeded", "Rate Limit Exceeded", {
    ...limitHeaders({ ...limited, remaining: 0 }),
    "Retry-After": String(wait),
  });
}

const invalid = (message: string, error = "InvalidRequest") =>
  xrpcError(400, error, message);

/**
 * Answers a request that an account makes, which costs `points` of what
 * the account may write: the proof and the token, the fault that strikes,
 * the limits, and then `respond`.
 */
async function forAccount(
  state: State,
  pds: Pds,
  request: Request,
  operation: Operation,
  points: number,
  respond: (caller: Caller) => Response | Promise<Response>,
): Promise<Response> {
  const caller = await authenticate(state, pds.host, request, (token) => {
    // Only now: a request that is refused for the nonce of its proof is
    // sent again, and the fault is for the request that counts. What
    // happens to a token comes before the token is looked at.
    const struck = state.takeFault(
      operation,
      ["token-revoked", "token-expired"],
      true,
    );
    const found = state.world.findToken<BlueskyToken>("bluesky", token);
    const session = found && state.sessions.get(found.sessionId);
    if (struck === "token-revoked" && session) revokeSession(state, session);
    if (struck === "token-expired") state.world.expireToken("bluesky", token);
    return undefined;
  });
  if (caller instanceof Response) return caller;
  // The rest strike a request that the server takes up: one that it has
  // refused for its token leaves them armed for the next.
  const fault = state.takeFault(
    operation,
    ["rate-limit", "server-error", "lost-response"],
    true,
  );
  if (fault === "server-error") return gatewayError();
  const headers: Record<string, string> = {
    "DPoP-Nonce": currentNonce(state, pds.host),
  };
  const limited = consume(state, caller.account.id, points);
  if (fault === "rate-limit" || limited.exceeded) {
    return tooManyRequests(state, limited);
  }
  const response = await respond(caller);
  if (fault === "lost-response") lose();
  for (const [name, value] of Object.entries({
    ...headers,
    ...limitHeaders(limited),
  })) {
    response.headers.set(name, value);
  }
  return response;
}

/** `POST /xrpc/com.atproto.repo.createRecord`: writes a new record. */
function createRecord(state: State, pds: Pds, request: Request) {
  return forAccount(state, pds, request, "publish", 3, async (caller) => {
    const body = await jsonBody(request);
    if (!body) return invalid("Input must be a JSON object");
    const { repo, collection, rkey, validate, record } = body;
    for (const name of Object.keys(body)) {
      if (
        !["repo", "collection", "rkey", "validate", "record"].includes(name)
      ) {
        return invalid(`The simulated PDS does not take "${name}"`);
      }
    }
    const account = accountOf(state, repo);
    if (!account || account.pds !== pds.host) {
      return invalid(`Could not find repo: ${String(repo)}`);
    }
    // An account writes to its own repository.
    if (account.id !== caller.account.id) {
      return xrpcError(
        401,
        "AuthenticationRequired",
        "Authentication Required",
      );
    }
    if (!isNsid(collection)) {
      return invalid("Input/collection must be a valid NSID");
    }
    if (collection !== postCollection) {
      return invalid(`The simulated PDS keeps no records of ${collection}`);
    }
    if (!allowsRepo(caller.session.scopes, collection, "create")) {
      // GUESS: the status and the name of this error are not documented.
      return xrpcError(
        403,
        "ScopeMissingError",
        `Missing required scope "repo:${collection}?action=create"`,
      );
    }
    if (rkey !== undefined && !isRecordKey(rkey)) {
      return invalid("Input/rkey must be a valid record key");
    }
    if (validate !== undefined && typeof validate !== "boolean") {
      return invalid("Input/validate must be a boolean");
    }
    if (validate !== false) {
      // A post is kept under a timestamp identifier, the lexicon says.
      if (rkey !== undefined && !isTid(rkey)) {
        return invalid(`Invalid record key for ${collection}: must be a tid`);
      }
      const problem = postProblem(state, record);
      if (problem) return invalid(`Invalid ${collection} record: ${problem}`);
    } else if (postProblem(state, record)) {
      return invalid("The simulated PDS keeps valid posts only");
    }

    const key = rkey ?? nextTid(state);
    const uri = recordUri(account.id, collection, key);
    if (state.posts.get(uri)) {
      // GUESS, from the code of the reference server, which has no answer
      // of its own for this: creating a record under a key that has one
      // fails inside the repository, as an error of the server.
      return xrpcError(500, "InternalServerError", "Internal Server Error");
    }
    const value = record as Record<string, unknown>;
    const reply = value.reply as { parent: { uri: string } } | undefined;
    const cid = await cidOf(value);
    const post: PostRecord = {
      network: "bluesky",
      id: uri,
      accountId: account.id,
      text: value.text as string,
      replyToId: reply?.parent.uri ?? null,
      // When the PDS took it, which is not what the record says of itself.
      createdAt: state.world.now().getTime(),
      url: postUrl(account.id, key),
      rkey: key,
      cid,
      record: value,
      ...shownOf(state, value),
    };
    // Nothing is awaited between the look above and here, so of two
    // requests with one key only one gets this far.
    if (state.posts.get(uri)) {
      return xrpcError(500, "InternalServerError", "Internal Server Error");
    }
    state.posts.put(uri, post);
    const rev = nextTid(state);
    return json(200, {
      uri,
      cid,
      commit: { cid: await cidOf({ uri, cid, rev }), rev },
      validationStatus: "valid",
    });
  });
}

/** `POST /xrpc/com.atproto.repo.deleteRecord`: removes a record, if it is there. */
function deleteRecord(state: State, pds: Pds, request: Request) {
  return forAccount(state, pds, request, "delete", 1, async (caller) => {
    const body = await jsonBody(request);
    if (!body) return invalid("Input must be a JSON object");
    const { repo, collection, rkey } = body;
    for (const name of Object.keys(body)) {
      if (!["repo", "collection", "rkey"].includes(name)) {
        return invalid(`The simulated PDS does not take "${name}"`);
      }
    }
    const account = accountOf(state, repo);
    if (!account || account.pds !== pds.host) {
      return invalid(`Could not find repo: ${String(repo)}`);
    }
    if (account.id !== caller.account.id) {
      return xrpcError(
        401,
        "AuthenticationRequired",
        "Authentication Required",
      );
    }
    if (!isNsid(collection)) {
      return invalid("Input/collection must be a valid NSID");
    }
    if (!isRecordKey(rkey)) {
      return invalid("Input/rkey must be a valid record key");
    }
    if (!allowsRepo(caller.session.scopes, collection, "delete")) {
      return xrpcError(
        403,
        "ScopeMissingError",
        `Missing required scope "repo:${collection}?action=delete"`,
      );
    }
    const uri = recordUri(account.id, collection, rkey);
    // "Delete a repository record, or ensure it doesn't exist."
    if (!state.posts.get(uri)) return json(200, {});
    state.posts.delete(uri);
    const rev = nextTid(state);
    return json(200, { commit: { cid: await cidOf({ uri, rev }), rev } });
  });
}

/** `GET /xrpc/com.atproto.repo.getRecord`: a record, for anybody. */
function getRecord(state: State, pds: Pds, url: URL) {
  const query = url.searchParams;
  const repo = query.get("repo");
  const collection = query.get("collection");
  const rkey = query.get("rkey");
  const operation: Operation =
    collection === profileCollection ? "profile" : "read";
  return withFaults(
    state,
    operation,
    async () => {
      if (!repo || !isNsid(collection) || !isRecordKey(rkey)) {
        return invalid(
          "Params must have the properties repo, collection and rkey",
        );
      }
      if (query.has("cid")) {
        return invalid("The simulated PDS keeps one version of a record");
      }
      const account = accountOf(state, repo);
      const uri = account && recordUri(account.id, collection, rkey);
      const notFound = () =>
        invalid(
          `Could not locate record: ${uri ?? `at://${repo}/${collection}/${rkey}`}`,
          "RecordNotFound",
        );
      // A real PDS asks elsewhere for a repository that it does not keep.
      // Here there is nowhere to ask.
      if (!account || !uri || account.pds !== pds.host) return notFound();
      if (collection === profileCollection) {
        if (rkey !== "self" || !account.profile) return notFound();
        const value = {
          $type: profileCollection,
          displayName: account.name,
          description: "A simulated account.",
        };
        return json(200, { uri, cid: await cidOf(value), value });
      }
      const post =
        collection === postCollection ? state.posts.get(uri) : undefined;
      return post
        ? json(200, { uri, cid: post.cid, value: post.record })
        : notFound();
    },
    // The HTTP API says so in its own words.
    () =>
      xrpcError(429, "RateLimitExceeded", "Rate Limit Exceeded", {
        "Retry-After": "60",
      }),
  );
}

/** Answers a request to the HTTP API of the PDS at `pds`. */
export function xrpc(
  state: State,
  pds: Pds,
  request: Request,
  url: URL,
): Promise<Response> | Response {
  const method = url.pathname.slice("/xrpc/".length);
  const { method: verb } = request;
  if (method === "com.atproto.repo.createRecord" && verb === "POST") {
    return createRecord(state, pds, request);
  }
  if (method === "com.atproto.repo.deleteRecord" && verb === "POST") {
    return deleteRecord(state, pds, request);
  }
  if (method === "com.atproto.repo.getRecord" && verb === "GET") {
    return getRecord(state, pds, url);
  }
  // What the specification has for a method that a server does not have.
  return xrpcError(501, "MethodNotImplemented", "Method Not Implemented");
}
