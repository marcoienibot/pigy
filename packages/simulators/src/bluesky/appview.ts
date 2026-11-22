import { json, withFaults, xrpcError } from "./http.ts";
import { parseRecordUri, postCollection } from "./record.ts";
import type { PostRecord, State } from "./state.ts";

/**
 * The part of an app view of Bluesky that pigy uses: the posts of the
 * network as anybody sees them, with what people did with each. Written
 * from the lexicon `app.bsky.feed.getPosts` with `app.bsky.feed.defs`
 * (`postView`), and the page "API Hosts and Auth" of https://docs.bsky.app,
 * which has Bluesky's public app view at `public.api.bsky.app`, for
 * requests without a token.
 *
 * An app view sees every PDS of the network, as the simulated one sees
 * every post of the world, and shows a post as soon as its PDS has
 * written it: a real one learns of it a moment later. Not simulated: the
 * feeds, the threads, the profiles and the moderation of an app view.
 */

/** Where Bluesky's public app view is. */
export const blueskyAppViewHost = "public.api.bsky.app";

/** The most posts that `getPosts` is asked for at once, by its lexicon. */
const maxUris = 25;

const invalid = (message: string) => xrpcError(400, "InvalidRequest", message);

/**
 * `GET /xrpc/app.bsky.feed.getPosts`: the posts of `uris`, each a
 * `postView`, in the order asked for. A post that the app view does not
 * have is left out, as the lexicon has it: one that was deleted, or that
 * was never there.
 */
function getPosts(state: State, url: URL) {
  return withFaults(
    state,
    "stats",
    () => {
      const uris = url.searchParams.getAll("uris");
      if (uris.length === 0) {
        return invalid('Error: Params must have the property "uris"');
      }
      if (uris.length > maxUris) {
        return invalid(
          `Error: uris must not have more than ${maxUris} elements`,
        );
      }
      const posts: Record<string, unknown>[] = [];
      for (const uri of uris) {
        // GUESS: an address that is no AT URI is refused, as the lexicon
        // says that each is one, and not left out.
        const record = parseRecordUri(uri);
        if (!record) return invalid("Error: uris must be valid at-uris");
        if (record.collection !== postCollection) continue;
        const post = state.posts.get(uri);
        if (post) posts.push(postView(state, post));
      }
      return json(200, { posts });
    },
    // The HTTP API says so in its own words.
    () =>
      xrpcError(429, "RateLimitExceeded", "Rate Limit Exceeded", {
        "Retry-After": "60",
      }),
  );
}

/** A post as an app view shows it: `postView` of `app.bsky.feed.defs`. */
function postView(state: State, post: PostRecord): Record<string, unknown> {
  const author = state.accounts.get(post.accountId);
  const engagement = state.world.engagementOf("bluesky", post);
  return {
    uri: post.id,
    cid: post.cid,
    author: {
      did: post.accountId,
      handle: author?.domain ?? "handle.invalid",
      ...(author && { displayName: author.name }),
    },
    record: post.record,
    // The replies in the world among them, also the account's own.
    replyCount: engagement.replies,
    repostCount: engagement.reposts,
    likeCount: engagement.likes,
    quoteCount: engagement.quotes,
    indexedAt: new Date(post.createdAt).toISOString(),
  };
}

/** Answers a request to the app view. */
export function appView(
  state: State,
  request: Request,
  url: URL,
): Promise<Response> | Response {
  if (
    request.method === "GET" &&
    url.pathname === "/xrpc/app.bsky.feed.getPosts"
  ) {
    return getPosts(state, url);
  }
  // What the specification has for a method that a server does not have.
  return xrpcError(501, "MethodNotImplemented", "Method Not Implemented");
}
