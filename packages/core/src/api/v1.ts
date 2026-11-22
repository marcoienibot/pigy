import { z } from "zod";
import { errorResponseSchema } from "../error.ts";
import { idSchema } from "../id.ts";
import { imageTypes, maxImageBytes, maxImagePixels } from "../media/image.ts";
import { type Network, networkSchema, networks } from "../network/network.ts";
import {
  channelStatusSchema,
  maxAltLength,
  maxImagesPerPart,
  maxParts,
  maxPartTextLength,
  maxSlots,
  maxTimeZoneLength,
  mediaStatusSchema,
  postStatusSchema,
  targetStatusSchema,
} from "../sync/tables.ts";
import { environmentSchema } from "../workspace.ts";
import { type ApiScope, apiScopeSchema, maxApiTime } from "./keys.ts";

/**
 * The public API, version 1: what its routes take and answer, and the list
 * of the routes themselves, `apiOperations`. The Worker parses with these
 * schemas and registers its routes from that list, and the OpenAPI
 * document of `./openapi.ts` is made from the same two, so the three
 * cannot say different things.
 *
 * The names are Buffer's where pigy has the same thing: camelCase fields,
 * `text`, `dueAt`, `saveToDraft`, `metadata` with `thread`, the values of
 * `mode` and of `status`, `pageInfo`. `PLAN.md` section 12 has what
 * differs and why.
 *
 * A schema that the document names is given its name with `named`.
 */

/** The path that every route of this version is under. */
export const apiBasePath = "/api/v1";

/** The largest body of a request, in bytes. */
export const maxApiBodyBytes = 256 * 1024;

/**
 * What an image of a part counts for in the budget of an answer,
 * `maxApiAnswerTextLength`, besides its description: about as many
 * characters as the rest of its entry in `assets` takes.
 */
export const apiImageWeight = 100;

/**
 * How many characters of the texts of posts one answer carries at most,
 * with the descriptions of their images, each image counting
 * `apiImageWeight` more. It bounds an answer whatever is in the
 * workspace: a post says its own text once, and the text of a channel
 * only where the channel has one of its own, but a post can have fifty
 * channels with a long text each.
 *
 * - A page of posts ends before the post that would take it past this,
 *   and has one post at least.
 * - One post says the texts that its channels have of their own for as
 *   long as there is room. For the rest of them it says that it left
 *   the text out, `textOmitted`, and never only null, which is what a
 *   channel without a text of its own says: an answer that lacks
 *   something says so. The text of the post itself, at most `maxParts`
 *   parts of `maxPartTextLength` characters with `maxImagesPerPart`
 *   images each, always has room.
 * - What was left out is read with `getPostTarget`, one channel at a
 *   time. The text of one channel always has room: it is at most as
 *   much as the post's own, by the mutators that write it, which is this
 *   budget and no more.
 */
export const maxApiAnswerTextLength =
  maxParts *
  (maxPartTextLength + maxImagesPerPart * (maxAltLength + apiImageWeight));

/**
 * The names of the schemas that the OpenAPI document lists by name. Each
 * is in Zod's registry under its name, with its description, which is
 * where the descriptions of the fields are too.
 */
export const apiSchemaNames = new Set<string>();

function named<Schema extends z.ZodType>(
  id: string,
  description: string,
  schema: Schema,
): Schema {
  apiSchemaNames.add(id);
  z.globalRegistry.add(schema, { id, description });
  return schema;
}

/** How many pixels an image has at most, in words. */
const maxImagePixelsWords = `${maxImagePixels / 1_000_000} million pixels`;

/** A moment as the API says it: ISO 8601, in UTC. */
const timeSchema = z.iso.datetime();

/**
 * A moment as the API takes it: ISO 8601, in UTC or with an offset, in the
 * year 9999 of UTC at the latest. A later one could not be said in an
 * answer.
 */
const givenTimeSchema = z.iso
  .datetime({ offset: true })
  .refine(
    (time) => new Date(time).getTime() <= maxApiTime,
    "A time is in the year 9999 at the latest",
  );

/**
 * `time`, milliseconds since the Unix epoch, as the API says it. A time
 * after the year 9999 is said as the last moment of that year: a date
 * writes such a year with six digits, which is not what the answers
 * promise, and the rows can hold one, because the mutator that schedules
 * a post takes every time that a date can hold. An answer never fails
 * for a time that is in the data.
 */
export function apiTime(time: number): string {
  return new Date(Math.min(time, maxApiTime)).toISOString();
}

export const apiErrorSchema = named(
  "Error",
  "What every answer that is not a success carries. `error` follows from the status: `UnauthorizedError` for 401 and 403, `NotFoundError` for 404, `LimitReachedError` for 429, `InvalidInputError` for every other 4xx, `UnexpectedError` for 5xx. `field` names the field of the request that the message is about, with dots between the parts of a nested one, where it is about one.",
  errorResponseSchema,
);

/**
 * How a post is given its time. The values are Buffer's.
 *
 * - `addToQueue`: at the end of the queue, which gives it the next free
 *   slot of the posting schedule.
 * - `shareNext`: at the front of the queue.
 * - `shareNow`: at once.
 * - `customScheduled`: at `dueAt`.
 */
export const apiModes = [
  "addToQueue",
  "shareNext",
  "shareNow",
  "customScheduled",
] as const;

export const apiModeSchema = z.enum(apiModes);

export type ApiMode = z.infer<typeof apiModeSchema>;

const partTextSchema = z.string().max(maxPartTextLength);

/** The longest address of an image that a request names. */
export const maxAssetUrlLength = 2048;

/**
 * How the server fetches the images at the addresses that a request
 * names, `image.url` of an asset: PLAN.md section 12, "Images".
 */
export const assetLimits = {
  /** How long the whole way to one file may take, its bytes included. */
  timeoutMs: 30_000,
  /** How often the request for a file may be sent on. */
  hops: 3,
  /** How many files are fetched at a time. */
  atOnce: 4,
  /** How many addresses one request may name. */
  perRequest: 20,
} as const;

/**
 * An image of a part as a request names it: one that was uploaded with
 * `POST /media`, by its ID, or one at an address, which the server
 * fetches while it takes the request. The shape is Buffer's, with
 * `mediaId` as what Buffer does not have.
 */
const assetInputSchema = named(
  "AssetInput",
  `An image of a part: \`image.mediaId\`, the \`id\` of an image uploaded with \`POST /media\`, or \`image.url\`, the address of one, never both. pigy fetches an address while it takes the request, and refuses the request if it cannot: the address has to be HTTPS, at a public host, and lead to the file itself, or send pigy on ${assetLimits.hops} times at most, and the file has to arrive within ${assetLimits.timeoutMs / 1000} seconds, be ${maxImageBytes / 1024 / 1024} MiB at most and be a JPEG, a PNG, a WebP or a GIF, by its bytes and whatever its address or its answer says. \`metadata.altText\` describes the image for whoever cannot see it.`,
  z.strictObject({
    image: z
      .strictObject({
        mediaId: idSchema.optional(),
        url: z.string().min(1).max(maxAssetUrlLength).optional(),
        metadata: z
          .strictObject({
            altText: z.string().max(maxAltLength).optional(),
          })
          .optional(),
      })
      .refine(
        (image) => (image.mediaId === undefined) !== (image.url === undefined),
        "Name an image by mediaId or by url, and not by both",
      ),
  }),
);

export type AssetInput = z.infer<typeof assetInputSchema>;

/** The images of one part, as a request names them. */
const assetsInputSchema = z.array(assetInputSchema).max(maxImagesPerPart);

/** One further part of a thread, as a request says it. */
const threadPartInputSchema = named(
  "ThreadPartInput",
  "One part of a thread after the first. `assets` are its images: in a new part none when left out, and in a part that a change of a post keeps, the ones that it has.",
  z.strictObject({
    text: partTextSchema,
    assets: assetsInputSchema.optional(),
  }),
);

const threadSchema = z.array(threadPartInputSchema).max(maxParts - 1);

/**
 * A text that the channels of one service get in place of the post's own.
 */
const serviceTextSchema = named(
  "ServiceText",
  "A text that the chosen channels of one service get in place of the post's own. `text` is its first part and is the post's `text` when left out, and `assets` are the images of that part, the post's own when left out. `thread` has its further parts, and none when left out: the thread of the post is not taken over.",
  z.strictObject({
    text: partTextSchema.optional(),
    assets: assetsInputSchema.optional(),
    thread: threadSchema.optional(),
  }),
);

const serviceTexts = Object.fromEntries(
  networks.map((network) => [network, serviceTextSchema.optional()]),
) as { [N in Network]: z.ZodOptional<typeof serviceTextSchema> };

export const apiPostMetadataSchema = named(
  "PostMetadataInput",
  "What a post has besides its first text. `thread` has the further parts of the post's own text, which makes it a thread: a chain of replies on most services, one joined post on LinkedIn. A key that names a service gives the chosen channels of that service a text of their own.",
  z.strictObject({ thread: threadSchema.optional(), ...serviceTexts }),
);

const nullableServiceTexts = Object.fromEntries(
  networks.map((network) => [network, serviceTextSchema.nullable().optional()]),
) as {
  [N in Network]: z.ZodOptional<z.ZodNullable<typeof serviceTextSchema>>;
};

const editedPostMetadataSchema = named(
  "PostMetadataEdit",
  "As in a new post. What is left out stays as it is. `thread` replaces the further parts of the post's own text, and a service that is named replaces the text of its channels: with null they get the post's own text again.",
  z.strictObject({ thread: threadSchema.optional(), ...nullableServiceTexts }),
);

/** The most channels that one post goes to. */
export const maxApiChannels = 50;

const channelIdsSchema = z
  .array(idSchema)
  .max(maxApiChannels)
  .refine(
    (ids) => new Set(ids).size === ids.length,
    "A channel is listed twice",
  );

const assetsSchema = assetsInputSchema
  .optional()
  .describe(
    `The images of the text, or of the first part of a thread: ${maxImagesPerPart} at most.`,
  );

export const createPostRequestSchema = named(
  "CreatePostRequest",
  "A new post. With `saveToDraft` it is a draft, which may hold anything: no channel, an empty text, a text that is too long. Otherwise `mode` says when it goes out, and the post has to be one that the app would publish: at least one channel, none that needs connecting again, no empty part, and every text within the limits of each channel that gets it.",
  z.strictObject({
    text: partTextSchema.describe(
      "The text of the post, or of the first part of a thread.",
    ),
    channelIds: channelIdsSchema
      .optional()
      .describe("The channels that the post goes to."),
    mode: apiModeSchema
      .optional()
      .describe("Required unless `saveToDraft` is true."),
    dueAt: givenTimeSchema
      .optional()
      .describe(
        "Required with the mode `customScheduled`, and refused with any other. In the year 9999 at the latest. A time that has passed is taken: the post goes out at once if it is at most an hour late, and is held for a person to decide otherwise.",
      ),
    saveToDraft: z
      .boolean()
      .optional()
      .describe("True keeps the post a draft, whatever `mode` says."),
    metadata: apiPostMetadataSchema.optional(),
    assets: assetsSchema,
  }),
);

export type CreatePostRequest = z.infer<typeof createPostRequestSchema>;

export const updatePostRequestSchema = named(
  "UpdatePostRequest",
  "What to change of a post that has not gone out: a draft, or one that is scheduled. What is left out stays as it is. A scheduled post that is changed keeps its time, or its place in the queue, unless `mode` or `saveToDraft` says otherwise, and has to pass the checks of a new post again.",
  z
    .strictObject({
      text: partTextSchema.optional(),
      channelIds: channelIdsSchema
        .optional()
        .describe("Replaces the channels that the post goes to."),
      mode: apiModeSchema.optional(),
      dueAt: givenTimeSchema
        .optional()
        .describe("Only with the mode `customScheduled`."),
      saveToDraft: z
        .boolean()
        .optional()
        .describe("True takes a scheduled post back to the drafts."),
      metadata: editedPostMetadataSchema.optional(),
      assets: assetsSchema,
    })
    .refine(
      (body) => Object.values(body).some((value) => value !== undefined),
      "Nothing to change",
    ),
);

export type UpdatePostRequest = z.infer<typeof updatePostRequestSchema>;

export const movePostRequestSchema = named(
  "MovePostRequest",
  "Where a post of the queue goes: after the post `afterId`, which has to be in the queue, or to the front for null.",
  z.strictObject({ afterId: idSchema.nullable() }),
);

export type MovePostRequest = z.infer<typeof movePostRequestSchema>;

/** An image of a part, as an answer says it. */
const apiAssetSchema = named(
  "Asset",
  "An image of a part. `image.mediaId` names it, and can be passed as it is in a request that changes the post. `status` is `ready` once the server has the image, `uploading` while an image that was attached in the app is on its way, and `failed` for one that the server did not take: a post with an image that is not `ready` does not go out.",
  z.strictObject({
    image: z.strictObject({
      mediaId: idSchema,
      status: mediaStatusSchema,
      metadata: z.strictObject({ altText: z.string() }),
    }),
  }),
);

export type ApiAsset = z.infer<typeof apiAssetSchema>;

/** One further part of a thread, as an answer says it. */
const threadPartSchema = named(
  "ThreadPart",
  "One part of a thread after the first, with its images.",
  z.strictObject({ text: z.string(), assets: z.array(apiAssetSchema) }),
);

export const apiTargetSchema = named(
  "Target",
  "The delivery of a post to one channel.",
  z.strictObject({
    channelId: idSchema,
    service: networkSchema
      .nullable()
      .describe("Null if the channel has been disconnected since."),
    status: targetStatusSchema.describe(
      "`pending` until the post is to go out, `queued` while it waits its turn on its channel, `sending`, `sent`, `error`, or `uncertain` for a delivery that ended without anybody knowing how far it got.",
    ),
    text: z
      .string()
      .nullable()
      .describe(
        "The first part of the text that the channel has of its own. Null if it has none: it gets the text of the post, `text`, `assets` and `metadata.thread` of the post. Also null where `textOmitted` is true.",
      ),
    assets: z
      .array(apiAssetSchema)
      .nullable()
      .describe(
        "The images of the first part of the text that the channel has of its own. Null wherever `text` is.",
      ),
    thread: z
      .array(threadPartSchema)
      .nullable()
      .describe(
        "The further parts of the text that the channel has of its own. Null wherever `text` is.",
      ),
    customized: z
      .boolean()
      .describe("True if the channel has a text of its own."),
    textOmitted: z
      .boolean()
      .describe(
        `True if the channel has a text of its own that this answer leaves out: \`text\`, \`assets\` and \`thread\` are null, and are not what the channel gets. An answer carries at most ${maxApiAnswerTextLength} characters of texts and descriptions of images, and a post says the texts of its channels for as long as there is room. Read the text that was left out with \`GET /posts/{id}/targets/{channelId}\`, which leaves nothing out.`,
      ),
    link: z
      .string()
      .nullable()
      .describe(
        "Where the post is on the network, once it is published. Null for a simulated network.",
      ),
    remoteId: z
      .string()
      .nullable()
      .describe("The network's ID of the post, once it is published."),
    error: z.string().nullable(),
    disconnected: z
      .boolean()
      .describe(
        "True if the delivery ended because the channel was disconnected while it waited or was under way. Such a delivery is in `error`, is never tried again and is not told of in the inbox of the app.",
      ),
    sentAt: timeSchema.nullable(),
    metrics: z
      .null()
      .describe("Not available yet: engagement comes with a later version."),
  }),
);

export const apiPostSchema = named(
  "Post",
  "A post, with its delivery to each of its channels.",
  z.strictObject({
    id: idSchema,
    status: postStatusSchema.describe(
      "`error` if the deliveries ended differently: `targets` says which arrived.",
    ),
    text: z.string(),
    assets: z
      .array(apiAssetSchema)
      .describe("The images of the text, or of the first part of a thread."),
    metadata: z.strictObject({ thread: z.array(threadPartSchema) }),
    channelIds: z.array(idSchema),
    mode: apiModeSchema
      .nullable()
      .describe(
        "How the post was given its time. Null for a draft. A post of the queue says `addToQueue`, wherever in the queue it was put.",
      ),
    dueAt: timeSchema
      .nullable()
      .describe(
        "When the post goes out, or was to. Null for a post of the queue while the queue is paused or has no posting times. A time after the year 9999, which the app can be made to store, is said as the last moment of that year.",
      ),
    heldAt: timeSchema
      .nullable()
      .describe(
        "Set for a scheduled post whose time was missed by more than an hour: it goes nowhere until it is given another time, shared now or taken back to the drafts.",
      ),
    createdAt: timeSchema,
    updatedAt: timeSchema,
    targets: z.array(apiTargetSchema),
  }),
);

export type ApiPost = z.infer<typeof apiPostSchema>;

export type ApiTarget = z.infer<typeof apiTargetSchema>;

/** How many posts a page has at most, and when nothing is said. */
export const maxApiPageSize = 100;
export const defaultApiPageSize = 20;

export const listPostsQuerySchema = z.strictObject({
  status: z
    .array(postStatusSchema)
    .min(1)
    .optional()
    .describe("Only the posts with one of these statuses."),
  channelId: idSchema
    .optional()
    .describe("Only the posts that go to this channel."),
  first: z
    .number()
    .int()
    .min(1)
    .max(maxApiPageSize)
    .optional()
    .describe(
      `How many posts to answer with: ${defaultApiPageSize} if left out.`,
    ),
  after: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("The `endCursor` of the page before."),
});

export type ListPostsQuery = z.infer<typeof listPostsQuerySchema>;

export const apiPostListSchema = named(
  "PostList",
  `A page of posts, the newest first. It can have fewer posts than \`first\` asked for, because an answer carries at most ${maxApiAnswerTextLength} characters of texts and descriptions of images: \`hasNextPage\` says whether more follow.`,
  z.strictObject({
    posts: z.array(apiPostSchema),
    pageInfo: z.strictObject({
      hasNextPage: z.boolean(),
      endCursor: z
        .string()
        .nullable()
        .describe("What to pass as `after` for the next page."),
    }),
  }),
);

export const apiChannelSchema = named(
  "Channel",
  "A connected social account.",
  z.strictObject({
    id: idSchema,
    service: networkSchema,
    serviceId: z.string().describe("The network's own ID of the account."),
    name: z.string(),
    handle: z.string(),
    avatarUrl: z.string().nullable(),
    profileUrl: z.string().nullable(),
    status: channelStatusSchema.describe(
      "`needs_reconnect` if the network no longer accepts pigy's access: a person has to connect the account again in the app.",
    ),
    connectedAt: timeSchema,
    expiresAt: timeSchema.nullable(),
    limits: z
      .strictObject({
        maxCharacters: z.number().int(),
        charactersPerUrl: z.number().int().optional(),
        maxBytes: z.number().int().optional(),
      })
      .nullable()
      .describe(
        "What one part of a post may be on this account, counted as its network counts. Null until the network has said.",
      ),
  }),
);

export type ApiChannel = z.infer<typeof apiChannelSchema>;

export const apiChannelListSchema = named(
  "ChannelList",
  "The channels of the workspace.",
  z.strictObject({ channels: z.array(apiChannelSchema) }),
);

export const apiAccountSchema = named(
  "Account",
  "Whose key this is, and what it reaches.",
  z.strictObject({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    workspace: z.strictObject({
      id: z.string(),
      environment: environmentSchema.describe(
        "`sandbox` for a key that begins with `pigy_test_`: its posts go to simulated networks.",
      ),
    }),
    apiKey: z.strictObject({
      id: z.string(),
      name: z.string(),
      scopes: z.array(apiScopeSchema),
      expiresAt: timeSchema.nullable(),
    }),
  }),
);

export type ApiAccount = z.infer<typeof apiAccountSchema>;

export const apiMediaSchema = named(
  "Media",
  "An image that the server has taken: what it read in the bytes, and the copy that it keeps, without what a camera wrote next to the picture. Put it into a post with its `id`, as `image.mediaId` of an asset. An image that is in no post is deleted a day after it was uploaded.",
  z.strictObject({
    id: idSchema,
    status: mediaStatusSchema.describe(
      "`ready`: the server has the image. The server answers for no other.",
    ),
    type: z.enum(imageTypes).describe("Read from the bytes of the file."),
    size: z
      .number()
      .int()
      .describe(
        "In bytes, of the copy that the server keeps and publishes, which can be smaller than the file.",
      ),
    width: z.number().int().describe("In pixels, as the picture is shown."),
    height: z.number().int(),
    animated: z
      .boolean()
      .describe(
        "Whether the picture moves: a GIF of several frames, for one. It goes out as a still picture where a network shows none that moves.",
      ),
    createdAt: timeSchema,
  }),
);

export type ApiMedia = z.infer<typeof apiMediaSchema>;

/** The days of the week as the API names them, Sunday first. */
export const apiDays = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
] as const;

const daySchema = z.enum(apiDays);

const clockTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "A time is written as HH:MM");

export const apiPostingScheduleSchema = named(
  "PostingSchedule",
  "The posting times of the queue, on the clocks of the time zone of the workspace.",
  z.strictObject({
    timeZone: z
      .string()
      .nullable()
      .describe(
        "An IANA name such as Europe/Rome. Null until one is set: the times are in UTC until then.",
      ),
    paused: z
      .boolean()
      .describe("While the queue is paused none of its posts goes out."),
    schedule: z.array(
      z.strictObject({ day: daySchema, times: z.array(clockTimeSchema) }),
    ),
  }),
);

export type ApiPostingSchedule = z.infer<typeof apiPostingScheduleSchema>;

export const putPostingScheduleRequestSchema = named(
  "PutPostingScheduleRequest",
  "Replaces the posting times. A day that is left out has none. `timeZone` and `paused` stay as they are when left out.",
  z.strictObject({
    timeZone: z.string().min(1).max(maxTimeZoneLength).optional(),
    paused: z.boolean().optional(),
    schedule: z
      .array(
        z.strictObject({
          day: daySchema,
          times: z.array(clockTimeSchema).max(maxSlots),
        }),
      )
      .max(apiDays.length)
      .refine(
        (days) => new Set(days.map(({ day }) => day)).size === days.length,
        "A day is listed twice",
      ),
  }),
);

export type PutPostingScheduleRequest = z.infer<
  typeof putPostingScheduleRequestSchema
>;

/** A route of the API. */
export type ApiOperation = {
  method: "get" | "post" | "put" | "patch" | "delete";
  /** Under `apiBasePath`, with a parameter in braces: `{id}`. */
  path: string;
  summary: string;
  description?: string;
  /** The scope that a key needs for it, or null if every key may. */
  scope: ApiScope | null;
  /** What the query may hold. */
  query?: z.ZodObject;
  /**
   * The body, for a route that takes one as JSON. Every route that is not
   * a GET takes `Idempotency-Key`, with a body or without.
   */
  request?: z.ZodType;
  /**
   * For a route whose body is the bytes of a file, and not JSON: the
   * types of file that it takes, by their bytes, and how many bytes.
   */
  upload?: { types: readonly string[]; maxBytes: number };
  /** The status of a success. */
  status: number;
  /** The body of a success, or null where it has none. */
  response: z.ZodType | null;
};

/** Every route of the API, by the name that the OpenAPI document has for it. */
export const apiOperations = {
  getAccount: {
    method: "get",
    path: "/account",
    summary: "Whose key this is",
    scope: null,
    status: 200,
    response: apiAccountSchema,
  },
  listChannels: {
    method: "get",
    path: "/channels",
    summary: "List the channels",
    scope: "channels:read",
    status: 200,
    response: apiChannelListSchema,
  },
  getChannel: {
    method: "get",
    path: "/channels/{id}",
    summary: "Get a channel",
    scope: "channels:read",
    status: 200,
    response: apiChannelSchema,
  },
  listPosts: {
    method: "get",
    path: "/posts",
    summary: "List the posts",
    description:
      "The newest first, by when they were created. Pass the `endCursor` of a page as `after` to get the next. A scheduled post that is held is listed as `scheduled`, with `heldAt`. A scheduled post that somebody is deleting in the app, while they can still undo that, is not listed, and every route answers for it with a 404.",
    scope: "posts:read",
    query: listPostsQuerySchema,
    status: 200,
    response: apiPostListSchema,
  },
  createPost: {
    method: "post",
    path: "/posts",
    summary: "Create a post",
    description:
      "Creates a post and, unless it is saved as a draft, shares it now, schedules it or puts it into the queue. All of it happens or none of it.",
    scope: "posts:write",
    request: createPostRequestSchema,
    status: 201,
    response: apiPostSchema,
  },
  getPost: {
    method: "get",
    path: "/posts/{id}",
    summary: "Get a post",
    scope: "posts:read",
    status: 200,
    response: apiPostSchema,
  },
  getPostTarget: {
    method: "get",
    path: "/posts/{id}/targets/{channelId}",
    summary: "Get the delivery of a post to one channel",
    description:
      "The delivery of the post `id` to the channel `channelId`, as an entry of `targets` of the post, with the text that the channel has of its own in full: `textOmitted` is always false here. It is how to read a text that the answer of a post, or of a page of posts, had no room for. A 404 if there is no such post, or if it does not go to that channel.",
    scope: "posts:read",
    status: 200,
    response: apiTargetSchema,
  },
  updatePost: {
    method: "patch",
    path: "/posts/{id}",
    summary: "Change a post",
    description:
      "Changes a draft or a scheduled post. A post that has gone out is refused with a 409. A scheduled post keeps its time, and a post of the queue its place, unless the request gives it another: a request that says the mode that the post has, with the time that it has as `dueAt` of an answer says it, changes neither. One that is held is held still then, and nobody is told of it a second time.",
    scope: "posts:write",
    request: updatePostRequestSchema,
    status: 200,
    response: apiPostSchema,
  },
  deletePost: {
    method: "delete",
    path: "/posts/{id}",
    summary: "Delete a post",
    description:
      "Deletes a post from pigy, at once and for good, a scheduled one too: it does not go out, and the inbox of the app says nothing of it any more. What it has published stays on the networks. A post that is being sent is refused with a 409.",
    scope: "posts:write",
    status: 204,
    response: null,
  },
  movePost: {
    method: "post",
    path: "/posts/{id}/move",
    summary: "Move a post in the queue",
    scope: "posts:write",
    request: movePostRequestSchema,
    status: 200,
    response: apiPostSchema,
  },
  getPostingSchedule: {
    method: "get",
    path: "/posting-schedule",
    summary: "Get the posting schedule",
    scope: "posts:read",
    status: 200,
    response: apiPostingScheduleSchema,
  },
  putPostingSchedule: {
    method: "put",
    path: "/posting-schedule",
    summary: "Set the posting schedule",
    description:
      "Replaces the posting times of the queue. The posts of the queue take the new times in their order.",
    scope: "posts:write",
    request: putPostingScheduleRequestSchema,
    status: 200,
    response: apiPostingScheduleSchema,
  },
  uploadMedia: {
    method: "post",
    path: "/media",
    summary: "Upload an image",
    description: `The body is the file itself, as it is, ${maxImageBytes / 1024 / 1024} MiB at most: \`curl --data-binary @photo.jpg\`. What it is, is read from its bytes, and neither its \`Content-Type\` nor its name counts: a JPEG, a PNG, a WebP or a GIF, of ${maxImagePixelsWords} at most. The server keeps a copy without what a camera wrote next to the picture, such as where and when it was taken, and answers when it has it: the image is \`ready\` then, and goes into a post as \`image.mediaId\` of an asset. A file that is no such image, or that cannot be drawn, is refused with a 400. One request carries the whole file: send it again with the same \`Idempotency-Key\` if the connection breaks. Every request counts as many times against the uploads of the owner of the key, which the app shares, as the 5 MiB that it takes in. An image that is in no post a day after it was uploaded is deleted.`,
    scope: "media:write",
    upload: { types: imageTypes, maxBytes: maxImageBytes },
    status: 201,
    response: apiMediaSchema,
  },
} as const satisfies Record<string, ApiOperation>;

export type ApiOperationName = keyof typeof apiOperations;

/** How an idempotency key may be written: up to 255 visible ASCII characters. */
export const idempotencyKeySchema = z.string().regex(/^[\x21-\x7e]{1,255}$/);
