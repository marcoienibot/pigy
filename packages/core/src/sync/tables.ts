import { z } from "zod";
import { idSchema } from "../id.ts";
import { limitsSchema } from "../network/limits.ts";
import { networkSchema } from "../network/network.ts";

/**
 * The synced tables: the part of a workspace that its clients hold a copy
 * of. A row is described here exactly as it travels and as mutators see it,
 * on the server and in the browser. The server may keep more columns in the
 * same table. They are not listed here, so they never leave it.
 *
 * The schemas are strict: a row with a field that is not listed is refused,
 * not trimmed. Changing anything here changes what clients must understand,
 * so it goes with a new `syncSchemaVersion` in protocol.ts.
 */

/** The statuses of a post. They are Buffer's, like the public API. */
export const postStatuses = [
  "draft",
  "scheduled",
  "sending",
  "sent",
  "error",
] as const;

export const postStatusSchema = z.enum(postStatuses);

export type PostStatus = z.infer<typeof postStatusSchema>;

/**
 * The longest text of one part, in UTF-16 code units, which is what
 * `String.length` counts. It is far above what any network accepts and has
 * nothing to do with their limits: it keeps a row and a sync message small.
 */
export const maxPartTextLength = 10_000;

/** A time, in milliseconds since the Unix epoch. */
const timeSchema = z.number().int().nonnegative();

/** One piece of content. Its text is in its parts. */
export const postRowSchema = z.strictObject({
  id: idSchema,
  status: postStatusSchema,
  createdAt: timeSchema,
  /** When the post or one of its parts last changed. */
  updatedAt: timeSchema,
});

/** One item of a thread. An ordinary post has a single part. */
export const postPartRowSchema = z.strictObject({
  id: idSchema,
  postId: idSchema,
  /**
   * Where the part stands in its post: parts are read in ascending order of
   * `position`, then of `id`.
   */
  position: z.number().int().nonnegative(),
  text: z.string().max(maxPartTextLength),
});

/** Whether pigy can act for the account of a channel. */
export const channelStatuses = [
  /** It can, as far as pigy knows. */
  "connected",
  /**
   * The network no longer accepts the access that pigy was given. The
   * person has to connect the account again, which brings the channel back
   * to `connected`.
   */
  "needs_reconnect",
] as const;

export const channelStatusSchema = z.enum(channelStatuses);

export type ChannelStatus = z.infer<typeof channelStatusSchema>;

/**
 * The longest values that a channel holds. What an account is called comes
 * from its network, so it is as long as the network lets it be. These keep
 * a row small whatever a network sends.
 */
export const channelLimits = {
  accountIdLength: 300,
  handleLength: 300,
  nameLength: 300,
  urlLength: 2000,
} as const;

/** An address that a browser may load or follow: HTTPS, and nothing else. */
const httpsUrlSchema = z
  .string()
  .max(channelLimits.urlLength)
  .startsWith("https://");

/**
 * A connected social account. The row says whose account it is, for
 * display. What pigy acts for the account with, its credentials, is kept
 * by the server next to the row and is not part of it.
 */
export const channelRowSchema = z.strictObject({
  id: idSchema,
  network: networkSchema,
  /**
   * The network's own, permanent ID of the account. A workspace has at
   * most one channel per network and account.
   */
  accountId: z.string().min(1).max(channelLimits.accountIdLength),
  /** How the network addresses the account, such as "@ada@mastodon.example". */
  handle: z.string().min(1).max(channelLimits.handleLength),
  /** The name the person goes by. */
  name: z.string().min(1).max(channelLimits.nameLength),
  /** A picture of the account, or null. */
  avatarUrl: httpsUrlSchema.nullable(),
  /** The account's page on the network, or null. */
  profileUrl: httpsUrlSchema.nullable(),
  status: channelStatusSchema,
  /** When the account was last connected: when pigy got the access it has. */
  connectedAt: timeSchema,
  /**
   * When that access ends unless the person connects again before, on a
   * network where it does. Null where no end is known.
   */
  expiresAt: timeSchema.nullable(),
  /**
   * What the account may post, as its network said when it was last asked:
   * `validateContent` checks content against it, in the browser while
   * somebody types and on the server before a post is sent. Null until the
   * network has answered once.
   */
  limits: limitsSchema.nullable(),
  /** When the network last said so. Null with `limits`. */
  limitsCheckedAt: timeSchema.nullable(),
});

/** The schema of a row of every synced table, by the name of the table. */
export const rowSchemas = {
  post: postRowSchema,
  post_part: postPartRowSchema,
  channel: channelRowSchema,
} as const;

export type TableName = keyof typeof rowSchemas;

export const tableNames = Object.keys(rowSchemas) as [
  TableName,
  ...TableName[],
];

/** A row of the synced table `Table`. */
export type Row<Table extends TableName> = z.infer<(typeof rowSchemas)[Table]>;
