import { z } from "zod";
import { errorResponseSchema } from "../error.ts";
import { idSchema } from "../id.ts";
import { type Network, networkSchema, networks } from "../network/network.ts";
import {
  channelStatusSchema,
  maxParts,
  maxPartTextLength,
  maxSlots,
  maxTimeZoneLength,
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

/** One further part of a thread. */
const threadPartSchema = named(
  "ThreadPart",
  "One part of a thread after the first.",
  z.strictObject({ text: partTextSchema }),
);

const threadSchema = z.array(threadPartSchema).max(maxParts - 1);

/**
 * A text that the channels of one service get in place of the post's own.
 */
const serviceTextSchema = named(
  "ServiceText",
  "A text that the chosen channels of one service get in place of the post's own. `text` is its first part and is the post's `text` when left out. `thread` has its further parts, and none when left out: the thread of the post is not taken over.",
  z.strictObject({
    text: partTextSchema.optional(),
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

const assetsSchema = z
  .array(z.unknown())
  .optional()
  .describe(
    "Not available yet: images come with a later version. A request with assets is refused.",
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

const apiTargetSchema = named(
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
    text: z.string().describe("The first part of the text that it gets."),
    thread: z.array(threadPartSchema),
    customized: z
      .boolean()
      .describe("True if the channel has a text of its own."),
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
  "A page of posts, the newest first.",
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
  /** Under `apiBasePath`, with `{id}` for a parameter. */
  path: string;
  summary: string;
  description?: string;
  /** The scope that a key needs for it, or null if every key may. */
  scope: ApiScope | null;
  /** What the query may hold. */
  query?: z.ZodObject;
  /**
   * The body, for a route that takes one. Every route that is not a GET
   * takes `Idempotency-Key`, with a body or without.
   */
  request?: z.ZodType;
  /** The status of a success. */
  status: number;
  /** The body of a success, or null where it has none. */
  response: z.ZodType | null;
  /** False for a route that only says that it is not there yet. */
  available?: false;
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
  updatePost: {
    method: "patch",
    path: "/posts/{id}",
    summary: "Change a post",
    description:
      "Changes a draft or a scheduled post. A post that has gone out is refused with a 409. A scheduled post keeps its time unless the request gives it another: one that is held is held still, and the inbox of the app says so anew.",
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
    summary: "Upload media",
    description:
      "Not available yet: images come with a later version. Every request is answered with a 501.",
    scope: null,
    status: 501,
    response: apiErrorSchema,
    available: false,
  },
} as const satisfies Record<string, ApiOperation>;

export type ApiOperationName = keyof typeof apiOperations;

/** How an idempotency key may be written: up to 255 visible ASCII characters. */
export const idempotencyKeySchema = z.string().regex(/^[\x21-\x7e]{1,255}$/);
