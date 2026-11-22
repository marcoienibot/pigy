import { type GraphError, graphError, json } from "./http.ts";
import {
  type Container,
  containerLifetimeMs,
  nextId,
  type Quota,
  quotas,
  quotaWindowMs,
  type State,
  type ThreadsPost,
  type ThreadsToken,
  type ThreadsUser,
  usageOf,
  use,
} from "./state.ts";
import { countCharacters, maxCharacters } from "./text.ts";

/**
 * The parts of the Threads API that an app uses to post text for an
 * account, after https://developers.facebook.com/docs/threads: "Posts",
 * "Reply Management", "Retrieve Threads Media Objects", "Delete Posts",
 * "Rate Limiting" and "Troubleshooting".
 *
 * GUESS, throughout: the words, the codes and the statuses of the
 * refusals. Meta documents the form of an error and few of the errors.
 */

/** Who asks: the account of the token, and what the token may do. */
export type Caller = { user: ThreadsUser; token: ThreadsToken };

/** How long a container is being prepared when a fault makes it slow. */
export const slowProcessingMs = 30_000;

const refuse = (state: State, error: GraphError) =>
  graphError(state.world, error);

/** What the API says of an ID that it has nothing under, or shows nobody. */
export const noSuchObject = (state: State, id: string) =>
  refuse(state, {
    message: `Unsupported request. Object with ID '${id}' does not exist, cannot be loaded due to missing permissions, or does not support this operation`,
    type: "THApiException",
    code: 100,
    subcode: 33,
  });

const invalidParameter = (state: State, message: string) =>
  refuse(state, { message, type: "THApiException", code: 100 });

/** A refusal unless the token of `caller` has every one of `scopes`. */
export function lacking(
  state: State,
  { token }: Caller,
  scopes: readonly string[],
): Response | undefined {
  const missing = scopes.find((scope) => !token.scopes.includes(scope));
  return missing === undefined
    ? undefined
    : refuse(state, {
        status: 403,
        message: `(#10) Application does not have permission for this action: it takes ${missing}`,
        type: "THApiException",
        code: 10,
      });
}

/** The address of a profile for people. */
const profileUrl = (user: ThreadsUser) =>
  `https://www.threads.com/@${user.username}`;

/** What a request asks for with `fields`: `id` alone, if it names none. */
function fieldsOf(params: URLSearchParams): string[] {
  const fields = (params.get("fields") ?? "").split(",").filter(Boolean);
  return fields.length > 0 ? fields : ["id"];
}

/**
 * An object with the `fields` that were asked for, from what it has. A
 * field that it does not have is refused, as the Graph API does.
 */
function pick(
  state: State,
  fields: string[],
  all: Record<string, unknown>,
): Record<string, unknown> | Response {
  const unknown = fields.find((field) => !(field in all));
  if (unknown !== undefined) {
    return invalidParameter(
      state,
      `(#100) Tried accessing nonexisting field (${unknown})`,
    );
  }
  return Object.fromEntries(
    fields
      .map((field) => [field, all[field]] as const)
      // A field without a value is left out of the answer.
      .filter(([, value]) => value !== undefined),
  );
}

/** `GET /me`: the profile of the account that the token is for. */
export function profile(
  state: State,
  { user }: Caller,
  params: URLSearchParams,
): Response {
  const picked = pick(state, fieldsOf(params), {
    id: user.id,
    username: user.username,
    name: user.name,
    // An account of a simulated world has no picture: there is no
    // address that could show one.
    threads_profile_picture_url: undefined,
    threads_biography: "",
    is_verified: false,
  });
  return picked instanceof Response ? picked : json(200, picked);
}

/** The status of a container, as Threads names it. */
function statusOf(state: State, container: Container) {
  if (container.publishedAs !== null) return "PUBLISHED";
  const now = state.world.now().getTime();
  if (now - container.createdAt >= containerLifetimeMs) return "EXPIRED";
  return now < container.readyAt ? "IN_PROGRESS" : "FINISHED";
}

// What a container can be made with that this does not simulate: media,
// carousels, links, quotes, polls, topics, places, and publishing in one
// step.
const notSimulated = [
  "image_url",
  "video_url",
  "is_carousel_item",
  "children",
  "link_attachment",
  "quote_post_id",
  "poll_attachment",
  "topic_tag",
  "location_id",
  "alt_text",
  "allowlisted_country_codes",
  "auto_publish_text",
  "text_entities",
  "gif_attachment",
];

const known = [
  "media_type",
  "text",
  "reply_to_id",
  "reply_control",
  "access_token",
  ...notSimulated,
];

/**
 * `POST /me/threads`: makes a container, which `threads_publish` then
 * publishes. `slow` is a fault: Threads takes its time to prepare it.
 */
export function createContainer(
  state: State,
  caller: Caller,
  params: URLSearchParams,
  slow: boolean,
): Response {
  const unknown = [...params.keys()].find((name) => !known.includes(name));
  if (unknown !== undefined) {
    return invalidParameter(state, `Unknown parameter: ${unknown}`);
  }
  const unsupported = notSimulated.find((name) => params.has(name));
  if (unsupported !== undefined) {
    return invalidParameter(
      state,
      `The simulated Threads publishes text only: it has no "${unsupported}"`,
    );
  }
  const mediaType = params.get("media_type");
  if (mediaType === null) {
    return invalidParameter(state, "The parameter media_type is required");
  }
  if (mediaType.toUpperCase() !== "TEXT") {
    return invalidParameter(
      state,
      `The simulated Threads publishes text only: it has no media_type "${mediaType}"`,
    );
  }
  const replyControl = params.get("reply_control");
  if (
    replyControl !== null &&
    !["everyone", "accounts_you_follow", "mentioned_only"].includes(
      replyControl,
    )
  ) {
    return invalidParameter(
      state,
      "Param reply_control must be one of {everyone, accounts_you_follow, mentioned_only}",
    );
  }
  const text = params.get("text") ?? "";
  if (text.trim() === "") {
    return invalidParameter(state, "The parameter text is required");
  }
  const characters = countCharacters(text);
  if (characters > maxCharacters) {
    return invalidParameter(
      state,
      `Param text must be at most ${maxCharacters} characters long.`,
    );
  }
  const replyToId = params.get("reply_to_id");
  if (replyToId !== null) {
    // GUESS: a reply takes the permission to manage replies, also one to
    // a post of the account's own. Meta documents `reply_to_id` with the
    // parameters of a post and replying under "Reply Management", whose
    // permissions are these.
    const refused = lacking(state, caller, ["threads_manage_replies"]);
    if (refused) return refused;
    if (!state.posts.get(replyToId)) return noSuchObject(state, replyToId);
  }
  const now = state.world.now().getTime();
  const container: Container = {
    id: nextId(state.world),
    userId: caller.user.id,
    text,
    replyToId,
    createdAt: now,
    readyAt: slow ? now + slowProcessingMs : now,
    publishedAs: null,
  };
  // A container that has expired is of no use to anybody.
  for (const [id, old] of state.containers.entries()) {
    if (
      old.publishedAs === null &&
      now - old.createdAt >= 2 * containerLifetimeMs
    ) {
      state.containers.delete(id);
    }
  }
  state.containers.put(container.id, container);
  return json(200, { id: container.id });
}

/** What Threads says when an account has done something too often. */
const overQuota = (state: State, quota: Quota) =>
  refuse(state, {
    status: 403,
    message: `(#613) Calls to this api have exceeded the rate limit: ${quotas[quota]} in 24 hours.`,
    code: 613,
  });

/** `POST /me/threads_publish`: publishes a container. */
export function publish(
  state: State,
  { user }: Caller,
  params: URLSearchParams,
): Response {
  const creationId = params.get("creation_id");
  if (!creationId) {
    return invalidParameter(state, "The parameter creation_id is required");
  }
  const container = state.containers.get(creationId);
  if (!container || container.userId !== user.id) {
    return noSuchObject(state, creationId);
  }
  const status = statusOf(state, container);
  if (status !== "FINISHED") {
    // GUESS: a container that was published is refused like one that is
    // not ready. Meta documents neither answer.
    return refuse(state, {
      message: `The requested resource does not exist: the container is ${status}`,
      type: "THApiException",
      code: 24,
      subcode: 4279009,
    });
  }
  // Replies have a quota of their own. GUESS: a reply to a post of the
  // account's own counts as a reply too.
  const quota: Quota = container.replyToId === null ? "post" : "reply";
  if (usageOf(state, quota, user.id).length >= quotas[quota]) {
    return overQuota(state, quota);
  }
  const id = nextId(state.world);
  const post: ThreadsPost = {
    network: "threads",
    id,
    accountId: user.id,
    // GUESS: Threads keeps the text as it was sent.
    text: container.text,
    replyToId: container.replyToId,
    createdAt: state.world.now().getTime(),
    shortcode: `C${BigInt(id).toString(36)}`,
    url: "",
  };
  post.url = `${profileUrl(user)}/post/${post.shortcode}`;
  state.posts.put(id, post);
  state.containers.put(container.id, { ...container, publishedAs: id });
  use(state, quota, user.id);
  return json(200, { id });
}

/** A time as the API writes one: in seconds, with the offset of UTC. */
const timestamp = (time: number) =>
  `${new Date(time).toISOString().slice(0, 19)}+0000`;

/** The post that begins the thread that `post` is in. */
function rootOf(state: State, post: ThreadsPost): ThreadsPost {
  let root = post;
  // A chain of a simulated world is short, and never a circle: a post
  // replies to one that was there before it.
  while (root.replyToId !== null) {
    const parent = state.posts.get(root.replyToId);
    if (!parent) break;
    root = parent;
  }
  return root;
}

/** A post with the fields that were asked for. */
function media(
  state: State,
  { user }: Caller,
  post: ThreadsPost,
  fields: string[],
): Record<string, unknown> | Response {
  const author = state.users.get(post.accountId);
  const isReply = post.replyToId !== null;
  return pick(state, fields, {
    id: post.id,
    media_product_type: "THREADS",
    media_type: "TEXT_POST",
    permalink: post.url,
    // Documented: the owner is only said of a post of the account's own.
    owner: post.accountId === user.id ? { id: post.accountId } : undefined,
    username: author?.username,
    text: post.text,
    timestamp: timestamp(post.createdAt),
    shortcode: post.shortcode,
    is_quote_post: false,
    has_replies: state.posts.all().some((other) => other.replyToId === post.id),
    is_reply: isReply,
    is_reply_owned_by_me: isReply ? post.accountId === user.id : undefined,
    replied_to: isReply ? { id: post.replyToId } : undefined,
    root_post: isReply ? { id: rootOf(state, post).id } : undefined,
    hide_status: isReply ? "NOT_HUSHED" : undefined,
  });
}

/**
 * `GET /{id}`: a container, with its status, a post, or the account
 * itself.
 */
export function object(
  state: State,
  caller: Caller,
  id: string,
  params: URLSearchParams,
): Response {
  if (id === caller.user.id) return profile(state, caller, params);
  const fields = fieldsOf(params);
  const container = state.containers.get(id);
  if (container) {
    // A container is its maker's alone.
    if (container.userId !== caller.user.id) return noSuchObject(state, id);
    const status = statusOf(state, container);
    const picked = pick(state, fields, {
      id: container.id,
      status,
      // Said only of a container that Threads could not prepare, which a
      // text is never.
      error_message: undefined,
    });
    return picked instanceof Response ? picked : json(200, picked);
  }
  const post = state.posts.get(id);
  if (!post) return noSuchObject(state, id);
  if (post.replyToId !== null) {
    // GUESS: a reply is read with the permission to read replies.
    const refused = lacking(state, caller, ["threads_read_replies"]);
    if (refused) return refused;
  }
  const picked = media(state, caller, post, fields);
  return picked instanceof Response ? picked : json(200, picked);
}

/**
 * A page of `posts`, newest first, as the Graph API pages a list: with a
 * cursor to go on from. Paging by time, with `since` and `until`, is not
 * simulated, and refused.
 */
function page(
  state: State,
  caller: Caller,
  posts: ThreadsPost[],
  params: URLSearchParams,
): Response {
  for (const name of ["since", "until", "before"]) {
    if (params.has(name)) {
      return invalidParameter(
        state,
        `The simulated Threads does not page with "${name}"`,
      );
    }
  }
  const limit = Number(params.get("limit") ?? 25);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return invalidParameter(
      state,
      "Param limit must be a number between 1 and 100",
    );
  }
  const newestFirst = posts.sort(
    (a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id),
  );
  // A cursor says nothing to an app: here it is the ID of the post that
  // the page before ended with, encoded.
  const after = params.get("after");
  let from = 0;
  if (after !== null) {
    let last: string;
    try {
      last = atob(after);
    } catch {
      last = "";
    }
    const index = newestFirst.findIndex(({ id }) => id === last);
    if (index < 0) return invalidParameter(state, "Invalid cursor");
    from = index + 1;
  }
  const listed = newestFirst.slice(from, from + limit);
  const fields = fieldsOf(params);
  const data: Record<string, unknown>[] = [];
  for (const post of listed) {
    const picked = media(state, caller, post, fields);
    if (picked instanceof Response) return picked;
    data.push(picked);
  }
  const [first] = listed;
  const last = listed.at(-1);
  return json(200, {
    data,
    // An empty page has no cursors: that is how a list ends.
    ...(first &&
      last && {
        paging: { cursors: { before: btoa(first.id), after: btoa(last.id) } },
      }),
  });
}

/**
 * `GET /me/threads`: the posts of the account. GUESS: without its
 * replies, which Threads lists at an address of their own.
 */
export function ownThreads(
  state: State,
  caller: Caller,
  params: URLSearchParams,
): Response {
  return page(
    state,
    caller,
    state.posts
      .all()
      .filter(
        (post) => post.accountId === caller.user.id && post.replyToId === null,
      ),
    params,
  );
}

/** `GET /{id}/replies`: the posts that reply to a post, by anybody. */
export function replies(
  state: State,
  caller: Caller,
  id: string,
  params: URLSearchParams,
): Response {
  if (!state.posts.get(id)) return noSuchObject(state, id);
  // Documented: newest first unless `reverse` is false.
  const reverse = params.get("reverse");
  if (reverse !== null && reverse !== "true") {
    return invalidParameter(
      state,
      "The simulated Threads lists replies newest first, and no other way",
    );
  }
  return page(
    state,
    caller,
    state.posts.all().filter((post) => post.replyToId === id),
    params,
  );
}

/** `GET /me/threads_publishing_limit`: how much of its quotas the account has used. */
export function publishingLimit(
  state: State,
  { user }: Caller,
  params: URLSearchParams,
): Response {
  const config = (quota: Quota) => ({
    quota_total: quotas[quota],
    quota_duration: quotaWindowMs / 1000,
  });
  const picked = pick(state, fieldsOf(params), {
    // This object has no ID: an answer that asks for no field is empty.
    id: undefined,
    quota_usage: usageOf(state, "post", user.id).length,
    config: config("post"),
    reply_quota_usage: usageOf(state, "reply", user.id).length,
    reply_config: config("reply"),
    delete_quota_usage: usageOf(state, "delete", user.id).length,
    delete_config: config("delete"),
  });
  return picked instanceof Response ? picked : json(200, { data: [picked] });
}

/**
 * `DELETE /{id}`: deletes a post of the account. Its replies stay. GUESS:
 * a post that is gone is answered like one that never was.
 */
export function deletePost(state: State, { user }: Caller, id: string) {
  const post = state.posts.get(id);
  if (!post || post.accountId !== user.id) return noSuchObject(state, id);
  if (usageOf(state, "delete", user.id).length >= quotas.delete) {
    return overQuota(state, "delete");
  }
  state.posts.delete(id);
  use(state, "delete", user.id);
  return json(200, { success: true, deleted_id: id });
}
