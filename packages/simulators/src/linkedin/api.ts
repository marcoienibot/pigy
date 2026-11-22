import { findLinks } from "../mastodon/text.ts";
import type { SimCard, SimEntity, SimImage } from "../world/world.ts";
import { apiError, empty, json } from "./http.ts";
import { imagesOf } from "./images.ts";
import {
  duplicateWindowMs,
  type LinkedInMember,
  type LinkedInPost,
  type State,
} from "./state.ts";
import { readLittleText } from "./text.ts";

/**
 * The two parts of LinkedIn's API that an application uses to post as a
 * member: who the member is, from "Sign In with LinkedIn using OpenID
 * Connect", and the Posts API,
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api.
 */

/** The most characters in the text of a post. */
const maxCharacters = 3000;

/** `GET /v2/userinfo`: the member that a token is for. */
export function userinfo(member: LinkedInMember): Response {
  return json(200, {
    sub: member.id,
    name: member.name,
    given_name: member.givenName,
    family_name: member.familyName,
    // A member of a simulated world has no picture: there is no address
    // that could show one.
    locale: { country: "US", language: "en" },
  });
}

/** The address of a post for people. */
export const postUrl = (id: string) =>
  `https://www.linkedin.com/feed/update/${id}/`;

// What a post can have that this does not simulate: a post that is shared
// again, a post in a group, a sponsored one. Of `content`, the article is
// simulated, which is how an application gives a link its preview, see
// `articleOf`, and images, one or several: images.ts.
const notSimulated = [
  "reshareContext",
  "container",
  "adContext",
  "contentLandingPage",
  "contentCallToActionLabel",
];

const known = [
  "author",
  "commentary",
  "visibility",
  "distribution",
  "lifecycleState",
  "isReshareDisabledByAuthor",
  "content",
  ...notSimulated,
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** What LinkedIn says of a field of the body that it does not take. */
const invalidField = (status: number, field: string, problem: string) =>
  apiError(
    status,
    `Field Value validation failed in REQUEST_BODY: Data Processing Exception while processing fields [/${field}]: ${problem}`,
  );

/**
 * What `content` gives a post: the preview of a link, or its images, or
 * what is wrong with it. A post has one content at most: "Posts API".
 *
 * Not simulated, and refused: every other content, which is a video, a
 * document, a poll and a carousel, and the picture of an article,
 * `thumbnail`, which is an image that was uploaded before.
 */
function contentOf(
  state: State,
  content: unknown,
  member: LinkedInMember,
):
  | { card: SimCard | null; images: SimImage[] }
  | { error: string; status: number; notSimulated?: true } {
  if (content === undefined) return { card: null, images: [] };
  if (!isRecord(content)) {
    return { status: 422, error: "content must be an object" };
  }
  const kinds = Object.keys(content);
  const [kind] = kinds;
  if (kinds.length !== 1) {
    return {
      status: 422,
      error: "content has one of article, media and multiImage",
    };
  }
  if (kind === "media" || kind === "multiImage") {
    const images = imagesOf(state, content, member);
    if (images === null || "error" in images) {
      return images ?? { status: 422, error: "content has no images" };
    }
    return { card: null, images };
  }
  if (kind !== "article") {
    return {
      status: 400,
      notSimulated: true,
      error: `The simulated LinkedIn takes an article or images for the content of a post, and no "${kind ?? "empty content"}"`,
    };
  }
  const card = articleOf(content.article);
  return "error" in card
    ? { status: card.notSimulated ? 400 : 422, ...card }
    : { card, images: [] as SimImage[] };
}

/**
 * The preview of a link that an article gives a post: "Posts API",
 * "Article Post Creation". LinkedIn reads no page for a post of an
 * application, so the application says what the preview shows: the
 * address, `source`, and a `title`, both required, and a `description`.
 */
function articleOf(
  article: unknown,
): SimCard | { error: string; notSimulated?: true } {
  if (!isRecord(article)) return { error: "content/article must be an object" };
  for (const field of Object.keys(article)) {
    if (field === "thumbnail") {
      return {
        notSimulated: true,
        error:
          "The simulated LinkedIn takes no picture for an article: an article has no thumbnail there",
      };
    }
    if (!["source", "title", "description"].includes(field)) {
      return { error: `content/article has no field "${field}"` };
    }
  }
  const { source, title, description } = article;
  let url: URL | undefined;
  try {
    url = typeof source === "string" ? new URL(source) : undefined;
  } catch {
    url = undefined;
  }
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
    return { error: "content/article/source must be a URL" };
  }
  if (typeof title !== "string" || title.trim() === "") {
    return { error: "content/article/title is required" };
  }
  if (description !== undefined && typeof description !== "string") {
    return { error: "content/article/description must be a string" };
  }
  return {
    url: source as string,
    title,
    description: (description as string | undefined) ?? "",
  };
}

/**
 * `POST /rest/posts`: publishes a post of `member`. The answer has no
 * body: the ID of the post is in the header `x-restli-id`.
 *
 * GUESS: the statuses and the words of the refusals. LinkedIn documents
 * the fields and that a post which repeats one is refused, and not what
 * each refusal looks like.
 */
export async function createPost(
  state: State,
  request: Request,
  member: LinkedInMember,
): Promise<Response> {
  if (
    !(request.headers.get("Content-Type") ?? "").startsWith("application/json")
  ) {
    return apiError(415, "The body of the request must be application/json");
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = undefined;
  }
  if (!isRecord(body)) {
    return apiError(400, "The body of the request is not a JSON object");
  }
  const unknown = Object.keys(body).find((field) => !known.includes(field));
  if (unknown !== undefined) {
    return apiError(
      422,
      `Unpermitted fields present in REQUEST_BODY: Data Processing Exception while processing fields [/${unknown}]`,
    );
  }
  const unsupported = notSimulated.find((field) => field in body);
  if (unsupported !== undefined) {
    return apiError(
      400,
      `The simulated LinkedIn publishes text only: it has no "${unsupported}"`,
    );
  }

  const { author, commentary, visibility, distribution, lifecycleState } = body;
  if (typeof author !== "string" || !/^urn:li:[a-zA-Z]+:[^:]+$/.test(author)) {
    return invalidField(422, "author", "a URN of a member is required");
  }
  if (!author.startsWith("urn:li:person:")) {
    return apiError(
      400,
      "The simulated LinkedIn publishes for members only, not for organizations",
    );
  }
  // A token posts as its member and as nobody else.
  if (author !== `urn:li:person:${member.id}`) {
    return apiError(403, "Not enough permissions to post as this author", {
      serviceErrorCode: 100,
      code: "ACCESS_DENIED",
    });
  }
  if (
    visibility !== "PUBLIC" &&
    visibility !== "CONNECTIONS" &&
    visibility !== "LOGGED_IN"
  ) {
    return invalidField(
      422,
      "visibility",
      "one of PUBLIC, CONNECTIONS and LOGGED_IN is required",
    );
  }
  if (
    !isRecord(distribution) ||
    distribution.feedDistribution !== "MAIN_FEED" ||
    !Object.entries(distribution).every(
      ([name, value]) =>
        name === "feedDistribution" ||
        ((name === "targetEntities" ||
          name === "thirdPartyDistributionChannels") &&
          Array.isArray(value) &&
          value.length === 0),
    )
  ) {
    return invalidField(
      422,
      "distribution",
      "the simulated LinkedIn distributes a post to the main feed, to nobody in particular",
    );
  }
  if (lifecycleState !== "PUBLISHED") {
    return invalidField(
      422,
      "lifecycleState",
      "the simulated LinkedIn takes a post that is PUBLISHED, and no draft",
    );
  }
  if (
    "isReshareDisabledByAuthor" in body &&
    typeof body.isReshareDisabledByAuthor !== "boolean"
  ) {
    return invalidField(422, "isReshareDisabledByAuthor", "not a boolean");
  }
  if (typeof commentary !== "string") {
    return invalidField(422, "commentary", "a text is required");
  }
  const read = readLittleText(commentary);
  if ("error" in read) return apiError(400, read.error);
  const { text } = read;
  const shown = contentOf(state, body.content, member);
  if ("error" in shown) {
    return shown.notSimulated || shown.status !== 422
      ? apiError(shown.status, shown.error)
      : invalidField(422, "content", shown.error);
  }
  // GUESS: a post of images needs no text, as one of a person's does not
  // in the app of LinkedIn.
  if (text.trim() === "" && shown.images.length === 0) {
    return invalidField(422, "commentary", "a post needs a text");
  }
  // GUESS: the limit is on the text as it shows, without the backslashes
  // of its escapes, and counts UTF-16 code units.
  if (text.length > maxCharacters) {
    return invalidField(
      422,
      "commentary",
      `the text is ${text.length} characters long, and the limit is ${maxCharacters}`,
    );
  }

  const now = state.world.now().getTime();
  // GUESS: a repetition is a post of the same text with the same images,
  // the very ones, as a post that is sent twice names them. A post of
  // the same words with other images is another.
  const blobs = (images: SimImage[] = []) =>
    images.map(({ blob }) => blob).join(",");
  const same = state.posts
    .all()
    .find(
      (post) =>
        post.accountId === member.id &&
        post.text === text &&
        blobs(post.images) === blobs(shown.images) &&
        now - post.createdAt < duplicateWindowMs,
    );
  if (same) {
    return json(422, {
      errorDetailType: "com.linkedin.common.error.BadRequest",
      message: `Content is a duplicate of ${same.id}`,
      errorDetails: {
        inputErrors: [
          {
            description: "Duplicate post is detected",
            input: {},
            code: "DUPLICATE_POST",
          },
        ],
      },
      status: 422,
    });
  }

  // An ID in the form of LinkedIn's: a long number that grows with time.
  const id = `urn:li:share:${
    (BigInt(now) << 22n) | BigInt(state.world.nextNumber() & 0x3fffff)
  }`;
  const post: LinkedInPost = {
    network: "linkedin",
    id,
    accountId: member.id,
    text,
    replyToId: null,
    createdAt: now,
    url: postUrl(id),
    visibility,
    entities: shownIn(text, read.hashtags),
    card: shown.card,
    ...(shown.images.length > 0 && { images: shown.images }),
  };
  state.posts.put(id, post);
  return empty(201, { "x-restli-id": id, "x-linkedin-id": id });
}

/**
 * What LinkedIn shows in the text of a post as more than text: the
 * hashtags that the post marked, and the links, which LinkedIn finds
 * itself. GUESS: what LinkedIn takes for a link is not documented. Here
 * it is what the simulated Mastodon takes for one, an address with its
 * scheme.
 */
function shownIn(text: string, hashtags: SimEntity[]): SimEntity[] {
  const links: SimEntity[] = findLinks(text)
    .map(({ start, end }) => ({
      kind: "link" as const,
      start,
      end,
      target: text.slice(start, end),
    }))
    .filter(
      (link) =>
        !hashtags.some((tag) => link.start < tag.end && tag.start < link.end),
    );
  return [...links, ...hashtags].sort((a, b) => a.start - b.start);
}

/**
 * `DELETE /rest/posts/{id}`: deletes a post of `member`. Deleting is
 * idempotent, as LinkedIn documents: a post that was deleted before is
 * answered like one that is deleted now.
 */
export function deletePost(
  state: State,
  id: string,
  member: LinkedInMember,
): Response {
  const post = state.posts.get(id);
  if (!post) {
    return state.deleted.get(id)
      ? empty(204)
      : // GUESS: what LinkedIn answers for a post that never was.
        apiError(404, `Could not find entity ${id}`);
  }
  if (post.accountId !== member.id) {
    return apiError(403, "Not enough permissions to delete this post", {
      serviceErrorCode: 100,
      code: "ACCESS_DENIED",
    });
  }
  state.posts.delete(id);
  state.deleted.put(id, true);
  return empty(204);
}
