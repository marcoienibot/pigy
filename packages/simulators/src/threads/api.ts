import type { Fetch } from "@pigy/core";
import { imageInfo, type SimImage } from "../world/index.ts";
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
import { countCharacters, findEntities, maxCharacters } from "./text.ts";

/**
 * The parts of the Threads API that an app uses to post text and images
 * for an account, after https://developers.facebook.com/docs/threads:
 * "Posts", "Carousel Posts", "Reply Management", "Retrieve Threads Media
 * Objects", "Delete Posts", "Rate Limiting" and "Troubleshooting".
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

/**
 * The fields of a list as the Graph API writes it: separated by commas,
 * where a field may name the fields of what it holds in braces, as
 * `children{id,alt_text}` does. GUESS: that Threads expands a field so,
 * as the Graph API of Facebook does. One level of braces is simulated.
 */
function splitFields(list: string): string[] {
  const fields: string[] = [];
  let depth = 0;
  let from = 0;
  for (let at = 0; at <= list.length; at++) {
    const char = list[at];
    if (char === "{") depth++;
    if (char === "}") depth--;
    if (at === list.length || (char === "," && depth === 0)) {
      if (at > from) fields.push(list.slice(from, at));
      from = at + 1;
    }
  }
  return fields;
}

/** What a request asks for with `fields`: `id` alone, if it names none. */
function fieldsOf(params: URLSearchParams): string[] {
  const fields = splitFields(params.get("fields") ?? "");
  return fields.length > 0 ? fields : ["id"];
}

/**
 * An object with the `fields` that were asked for, from what it has. A
 * field that it does not have is refused, as the Graph API does. A field
 * that holds a list, as the items of a carousel, gives the `id` of each
 * unless the fields of them are named in braces.
 */
function pick(
  state: State,
  fields: string[],
  all: Record<string, unknown>,
): Record<string, unknown> | Response {
  const picked: Record<string, unknown> = {};
  for (const field of fields) {
    const braces = /^([a-z_]+)\{(.*)\}$/.exec(field);
    const name = braces?.[1] ?? field;
    if (!(name in all) || (!braces && field.includes("{"))) {
      return invalidParameter(
        state,
        `(#100) Tried accessing nonexisting field (${field})`,
      );
    }
    const value = all[name];
    // A field without a value is left out of the answer.
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      if (braces) {
        return invalidParameter(
          state,
          `(#100) The field ${name} holds nothing to name fields of`,
        );
      }
      picked[name] = value;
      continue;
    }
    const data: Record<string, unknown>[] = [];
    for (const item of value as Record<string, unknown>[]) {
      const inner = pick(
        state,
        braces ? splitFields(braces[2] ?? "") : ["id"],
        item,
      );
      if (inner instanceof Response) return inner;
      data.push(inner);
    }
    picked[name] = { data };
  }
  return picked;
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
  if (now < container.readyAt) return "IN_PROGRESS";
  return container.error === undefined ? "FINISHED" : "ERROR";
}

// What a container can be made with that this does not simulate: videos,
// links, quotes, polls, topics, places, and publishing in one step.
const notSimulated = [
  "video_url",
  "link_attachment",
  "quote_post_id",
  "poll_attachment",
  "topic_tag",
  "location_id",
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
  "image_url",
  "alt_text",
  "is_carousel_item",
  "children",
  ...notSimulated,
];

/** The most bytes of an image that Threads fetches: documented, 8 MB. */
export const maxImageBytes = 8 * 1024 * 1024;

/** How much longer one side of an image may be: documented, ten to one. */
const maxAspectRatio = 10;

/**
 * The longest description of an image. GUESS: Threads documents
 * `alt_text` and not how long it may be.
 */
export const maxAltLength = 1000;

/** How many items a carousel has: documented, 20 at most. GUESS: 2 at least. */
export const carouselRange = { min: 2, max: 20 } as const;

/**
 * The image at `url`, as Threads fetches the `image_url` of a container:
 * with `web`, which is whatever the world reaches of the web, or what is
 * wrong with it. Threads documents what it takes, and not what it says
 * of what it does not: GUESS, the words. They never repeat the address,
 * which can be good for whoever has it.
 */
async function fetchedImage(
  world: State["world"],
  web: Fetch | undefined,
  url: string,
): Promise<SimImage | { error: string }> {
  let response: Response;
  try {
    if (!web) throw new TypeError("This world reaches no web");
    response = await web(url);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return { error: "The media could not be fetched from the URI." };
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    return {
      error: `The media could not be fetched from the URI: it answered with HTTP ${response.status}.`,
    };
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > maxImageBytes) {
    return { error: "The image is larger than 8 MB." };
  }
  const info = imageInfo(bytes);
  if (!info || (info.type !== "image/jpeg" && info.type !== "image/png")) {
    return { error: "The media type is not supported: it takes JPEG and PNG." };
  }
  const ratio =
    Math.max(info.width, info.height) /
    Math.max(1, Math.min(info.width, info.height));
  if (ratio > maxAspectRatio) {
    return { error: "The aspect ratio of the image is not supported." };
  }
  return {
    blob: world.blobs.put(bytes),
    type: info.type,
    width: info.width,
    height: info.height,
    size: bytes.length,
    alt: "",
  };
}

/**
 * `POST /me/threads`: makes a container, which `threads_publish` then
 * publishes: of a text, of an image, which Threads fetches from the
 * address `image_url` with `web`, or of a carousel, whose items are
 * containers of images with `is_carousel_item` that were made before.
 * `slow` is a fault: Threads takes its time to prepare it.
 *
 * GUESS: Threads fetches an image while it makes the container, and says
 * what was wrong with it by the status `ERROR` and `error_message` of the
 * container, and not by refusing the request.
 */
export async function createContainer(
  state: State,
  caller: Caller,
  params: URLSearchParams,
  slow: boolean,
  web: Fetch | undefined,
): Promise<Response> {
  const unknown = [...params.keys()].find((name) => !known.includes(name));
  if (unknown !== undefined) {
    return invalidParameter(state, `Unknown parameter: ${unknown}`);
  }
  const unsupported = notSimulated.find((name) => params.has(name));
  if (unsupported !== undefined) {
    return invalidParameter(
      state,
      `The simulated Threads publishes text and images only: it has no "${unsupported}"`,
    );
  }
  const mediaType = params.get("media_type")?.toUpperCase();
  if (mediaType === undefined) {
    return invalidParameter(state, "The parameter media_type is required");
  }
  if (
    mediaType !== "TEXT" &&
    mediaType !== "IMAGE" &&
    mediaType !== "CAROUSEL"
  ) {
    return invalidParameter(
      state,
      `The simulated Threads publishes text and images only: it has no media_type "${mediaType}"`,
    );
  }
  // What belongs to a kind of container and no other.
  const misplaced = (
    [
      ["image_url", mediaType === "IMAGE"],
      ["alt_text", mediaType === "IMAGE"],
      ["is_carousel_item", mediaType === "IMAGE"],
      ["children", mediaType === "CAROUSEL"],
    ] as const
  ).find(([name, belongs]) => params.has(name) && !belongs)?.[0];
  if (misplaced !== undefined) {
    return invalidParameter(
      state,
      `Param ${misplaced} is not valid for media_type ${mediaType}`,
    );
  }
  const carouselItem = params.get("is_carousel_item");
  if (
    carouselItem !== null &&
    carouselItem !== "true" &&
    carouselItem !== "false"
  ) {
    return invalidParameter(state, "Param is_carousel_item must be a boolean");
  }
  const isItem = carouselItem === "true";
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
  // GUESS: an item of a carousel has no text of its own, and replies to
  // nothing: the carousel does.
  if (isItem && (params.has("text") || params.has("reply_to_id"))) {
    return invalidParameter(
      state,
      "An item of a carousel takes no text and no reply_to_id: the carousel does",
    );
  }
  // A post of images needs no text.
  if (mediaType === "TEXT" && text.trim() === "") {
    return invalidParameter(state, "The parameter text is required");
  }
  const characters = countCharacters(text);
  if (characters > maxCharacters) {
    return invalidParameter(
      state,
      `Param text must be at most ${maxCharacters} characters long.`,
    );
  }
  const alt = params.get("alt_text") ?? "";
  if ([...alt].length > maxAltLength) {
    return invalidParameter(
      state,
      `Param alt_text must be at most ${maxAltLength} characters long.`,
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
    const repliedTo = state.posts.get(replyToId);
    if (!repliedTo) return noSuchObject(state, replyToId);
    // Documented: with this permission an app replies in the threads
    // that the account began. A reply under somebody else's post takes
    // permissions that are not simulated. GUESS: the words and the code
    // of the refusal.
    if (rootOf(state, repliedTo).accountId !== caller.user.id) {
      return refuse(state, {
        status: 403,
        message:
          "(#10) Application does not have permission for this action: the post that begins the thread is not the account's own",
        type: "THApiException",
        code: 10,
      });
    }
  }
  const now = state.world.now().getTime();
  let made: Pick<Container, "image" | "children" | "error"> = {};
  if (mediaType === "IMAGE") {
    const address = params.get("image_url");
    let url: URL | undefined;
    try {
      url = address === null ? undefined : new URL(address);
    } catch {
      url = undefined;
    }
    if (url?.protocol !== "https:") {
      return invalidParameter(
        state,
        "Param image_url must be an HTTPS address",
      );
    }
    const image = await fetchedImage(state.world, web, url.href);
    made =
      "error" in image ? { error: image.error } : { image: { ...image, alt } };
  }
  if (mediaType === "CAROUSEL") {
    const children = (params.get("children") ?? "").split(",").filter(Boolean);
    if (
      children.length < carouselRange.min ||
      children.length > carouselRange.max
    ) {
      return invalidParameter(
        state,
        `Param children must name ${carouselRange.min} to ${carouselRange.max} containers`,
      );
    }
    for (const id of children) {
      const child = state.containers.get(id);
      if (!child || child.userId !== caller.user.id) {
        return noSuchObject(state, id);
      }
      // GUESS: an item that is not ready is refused like one that is no
      // item.
      if (!child.carouselItem || statusOf(state, child) !== "FINISHED") {
        return invalidParameter(
          state,
          `The container ${id} is no item of a carousel that is ready`,
        );
      }
    }
    made = { children };
  }
  const container: Container = {
    id: nextId(state.world),
    userId: caller.user.id,
    mediaType,
    ...(isItem && { carouselItem: true }),
    ...made,
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

/** What a post is made of, besides who posts it and when. */
export type NewPost = Pick<ThreadsPost, "text" | "replyToId"> &
  Pick<
    Partial<ThreadsPost>,
    | "media"
    | "images"
    | "childIds"
    | "quote"
    | "poll"
    | "entities"
    | "card"
    | "topicTag"
  >;

/** Puts a post of `user` into the world, now. It checks nothing. */
export function addPost(
  state: State,
  user: ThreadsUser,
  post: NewPost,
): ThreadsPost {
  const id = nextId(state.world);
  const shortcode = `C${BigInt(id).toString(36)}`;
  const added: ThreadsPost = {
    ...post,
    network: "threads",
    id,
    accountId: user.id,
    createdAt: state.world.now().getTime(),
    shortcode,
    url: `${profileUrl(user)}/post/${shortcode}`,
  };
  state.posts.put(id, added);
  return added;
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
  // GUESS: an item of a carousel is published with its carousel only.
  if (container.carouselItem) {
    return invalidParameter(
      state,
      "An item of a carousel is published with its carousel",
    );
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
  // GUESS: Threads keeps the text as it was sent. What it shows in it as
  // more than text, it finds itself: text.ts.
  const { entities, card, topicTag } = findEntities(
    container.text,
    (username) =>
      state.users
        .all()
        .find((known) => known.username.toLowerCase() === username)?.id,
  );
  // The images of the post: its own, or those of the items of its
  // carousel, in their order.
  const items = (container.children ?? []).flatMap(
    (id) => state.containers.get(id)?.image ?? [],
  );
  const images = container.image ? [container.image] : items;
  const { id } = addPost(state, user, {
    text: container.text,
    replyToId: container.replyToId,
    entities,
    // GUESS: a post with images shows no preview of a link.
    card: images.length > 0 ? null : card,
    ...(topicTag !== null && { topicTag }),
    ...(container.mediaType === "IMAGE" && { media: "IMAGE", images }),
    ...(container.mediaType === "CAROUSEL" && {
      media: "CAROUSEL_ALBUM",
      images,
      childIds: images.map(() => nextId(state.world)),
    }),
  });
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
    // Documented: a post of text says TEXT_POST, where its container was
    // made as TEXT, and one of a carousel CAROUSEL_ALBUM.
    media_type: post.media ?? "TEXT_POST",
    // GUESS: a post of one image says what it shows here, and a carousel
    // says it of each of its items.
    alt_text:
      post.media === "IMAGE" ? (post.images?.[0]?.alt ?? "") : undefined,
    children:
      post.media === "CAROUSEL_ALBUM"
        ? (post.images ?? []).map((image, index) => ({
            id: post.childIds?.[index] ?? `${post.id}${index}`,
            media_type: "IMAGE",
            alt_text: image.alt,
          }))
        : undefined,
    permalink: post.url,
    // Documented: the owner is only said of a post of the account's own.
    owner: post.accountId === user.id ? { id: post.accountId } : undefined,
    username: author?.username,
    text: post.text,
    timestamp: timestamp(post.createdAt),
    shortcode: post.shortcode,
    is_quote_post: post.quote === true,
    // Documented fields of a post: the address that its link preview is
    // of, and its one topic tag. Left out where it has none.
    link_attachment_url: post.card?.url,
    topic_tag: post.topicTag,
    // GUESS: a post says its poll like this, and one without a poll
    // leaves the field out.
    poll_attachment: post.poll
      ? { option_a: "Yes", option_b: "No" }
      : undefined,
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
      error_message: status === "ERROR" ? container.error : undefined,
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

/**
 * The metrics of the insights of a media object that the simulation has,
 * by their names, and what each is of what people did with a post. GUESS,
 * PLAN.md section 19: the names and the form of the answer are those that
 * Meta documents for "Insights", from what its author knew of them, and
 * a metric that the simulation does not have is refused as one that
 * Threads does not have. Threads has `shares` too, which pigy does not ask.
 */
const mediaMetrics = {
  views: "views",
  likes: "likes",
  replies: "replies",
  reposts: "reposts",
  quotes: "quotes",
} as const;

const isMediaMetric = (name: string): name is keyof typeof mediaMetrics =>
  Object.hasOwn(mediaMetrics, name);

/**
 * `GET /{id}/insights`: what people did with a post of the account, by
 * the metrics that `metric` names, over the life of the post. Only the
 * account's own posts have insights for it.
 */
export function insights(
  state: State,
  { user }: Caller,
  id: string,
  params: URLSearchParams,
): Response {
  const post = state.posts.get(id);
  if (!post || post.accountId !== user.id) return noSuchObject(state, id);
  const asked = (params.get("metric") ?? "").split(",").filter(Boolean);
  if (asked.length === 0) {
    return invalidParameter(state, "(#100) The parameter metric is required");
  }
  if (!asked.every(isMediaMetric)) {
    return invalidParameter(
      state,
      `(#100) metric must be one of the following values: ${Object.keys(mediaMetrics).join(", ")}`,
    );
  }
  // As Meta documents `replies` of a media object: of a post that begins
  // a thread, every reply in the thread below it, the account's own
  // among them, and of a reply, the replies to it alone.
  const engagement = state.world.engagementOf("threads", post, {
    nested: post.replyToId === null,
  });
  return json(200, {
    data: asked.map((name) => ({
      name,
      period: "lifetime",
      values: [{ value: engagement[mediaMetrics[name]] }],
      title: name.charAt(0).toUpperCase() + name.slice(1),
      description: `The number of ${name} of the post.`,
      id: `${id}/insights/${name}/lifetime`,
    })),
  });
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
