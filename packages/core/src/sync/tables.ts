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

/**
 * The most parts that one text has: a post, and the text that an account
 * gets in its place. Far more than a thread that anybody reads.
 */
export const maxParts = 100;

/**
 * The longest text that an account is given in place of the post's own in
 * one step, all its parts together, in UTF-16 code units. The step is one
 * mutation, which has to fit one message of the sync protocol, also when
 * JSON writes every character as six.
 */
export const maxOwnTextLength = 40_000;

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

/**
 * One item of a thread. An ordinary post has a single part.
 *
 * A post has a text of its own, and an account can be given another in
 * its place: the parts of a post are those of its own text, whose
 * `targetId` is null, and those that one of its targets gets instead,
 * which name the target. A target that no part names gets the post's own.
 * Each of these texts is a thread of its own, with its own number of
 * parts.
 */
export const postPartRowSchema = z.strictObject({
  id: idSchema,
  postId: idSchema,
  /**
   * The target of the post that this part is written for, in place of the
   * post's own text. Null for a part of the post's own text.
   */
  targetId: idSchema.nullable(),
  /**
   * Where the part stands in its text: the parts of one text are read in
   * ascending order of `position`, then of `id`. The mutators that add,
   * remove and move a part number the parts of its text anew, from 0.
   */
  position: z.number().int().nonnegative(),
  text: z.string().max(maxPartTextLength),
});

/** `parts`, which are those of one post, in the order they are read in. */
export function inReadingOrder<Part extends { id: string; position: number }>(
  parts: readonly Part[],
): Part[] {
  return [...parts].sort(
    (a, b) => a.position - b.position || (a.id < b.id ? -1 : 1),
  );
}

/**
 * The parts of the post's own text among `parts`, which are those of one
 * post, in the order they are read in.
 */
export function ownParts<
  Part extends { id: string; position: number; targetId: string | null },
>(parts: readonly Part[]): Part[] {
  return inReadingOrder(parts.filter((part) => part.targetId === null));
}

/**
 * What the target `targetId` gets of `parts`, which are those of its post,
 * in the order they are read in: the text that was written for it, or the
 * post's own if there is none.
 */
export function partsFor<
  Part extends { id: string; position: number; targetId: string | null },
>(parts: readonly Part[], targetId: string): Part[] {
  const written = parts.filter((part) => part.targetId === targetId);
  return written.length > 0 ? inReadingOrder(written) : ownParts(parts);
}

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

/** How far the delivery of a post to one channel has come. */
export const targetStatuses = [
  /** The channel is chosen. Nobody has asked for the post to be sent. */
  "pending",
  /**
   * The post is to be sent, and the target waits its turn: the deliveries
   * to one channel go out one after the other.
   */
  "queued",
  /** The post is on its way to the channel. */
  "sending",
  /** Every part is published. */
  "sent",
  /**
   * The delivery failed, and `error` says why. The parts that were
   * published before stay published, and are listed. It can be tried again.
   */
  "error",
  /**
   * The delivery ended and nobody knows how: a part may be published
   * without pigy knowing. A person has to look at the account before they
   * ask for another try. `error` says so.
   */
  "uncertain",
] as const;

export const targetStatusSchema = z.enum(targetStatuses);

export type TargetStatus = z.infer<typeof targetStatusSchema>;

/** The longest values that a target and the result of a part hold. */
export const targetLimits = {
  errorLength: 1000,
  remoteIdLength: 300,
} as const;

/**
 * The delivery of a post to one channel. A post has at most one target per
 * channel. The target outlives its channel: when the account is
 * disconnected, `channelId` names a channel that is no longer there.
 */
export const postTargetRowSchema = z.strictObject({
  id: idSchema,
  postId: idSchema,
  channelId: idSchema,
  status: targetStatusSchema,
  /**
   * How often the delivery was begun: 0 until the first time, and one more
   * for every time it is taken up again after a failure.
   */
  attempt: z.number().int().nonnegative(),
  /**
   * Why the delivery failed, for the person. Null unless the status is
   * `error` or `uncertain`.
   */
  error: z.string().min(1).max(targetLimits.errorLength).nullable(),
  /**
   * When the delivery was last asked for, by publishing the post or by
   * trying the target again. The targets of one channel are sent in this
   * order. Null while the target is `pending`.
   */
  queuedAt: timeSchema.nullable(),
  /** When the last part was published. Null unless the status is `sent`. */
  sentAt: timeSchema.nullable(),
});

/**
 * Where one part of a post stands on the network of a target, once it is
 * published there. A thread goes out part by part, and so do these rows.
 */
export const targetPartResultRowSchema = z.strictObject({
  id: idSchema,
  targetId: idSchema,
  /**
   * One of the parts that the target gets: the post's own, or the ones
   * that were written for the target.
   */
  partId: idSchema,
  /**
   * The network's ID of the post that the part is in. Parts that a network
   * joins into one post share it.
   */
  remoteId: z.string().min(1).max(targetLimits.remoteIdLength),
  /**
   * A link to the post for people, or null: where the network gives none,
   * and for a simulated network, whose posts no browser can open.
   */
  url: httpsUrlSchema.nullable(),
});

/** What a notification of the inbox is about. */
export const notificationKinds = [
  /**
   * A post has ended and has not arrived everywhere: a delivery of it has
   * failed, or nobody knows how one ended. `postId` names the post.
   */
  "post_failed",
  /**
   * A network no longer takes the access of a channel, which has to be
   * connected again. `channelId` names the channel.
   */
  "channel_needs_reconnect",
  /**
   * The access of a channel ends in a week, on a network where it ends by
   * a date. `channelId` names the channel.
   */
  "channel_expiring",
] as const;

export const notificationKindSchema = z.enum(notificationKinds);

export type NotificationKind = z.infer<typeof notificationKindSchema>;

/**
 * How long before the access of a channel ends the person is told, in
 * milliseconds: a week.
 */
export const expiryNoticeMs = 7 * 24 * 60 * 60 * 1000;

/**
 * Something that the person has to hear of and may have to deal with, in
 * the inbox of the app. There is at most one about a post and one about a
 * channel: its `id` is the ID of what it is about. It goes when what it is
 * about is dealt with or gone, when the person dismisses it, and when it
 * is old.
 */
export const notificationRowSchema = z.strictObject({
  /** The ID of the post or of the channel that it is about. */
  id: idSchema,
  kind: notificationKindSchema,
  /** The post that it is about, or null. */
  postId: idSchema.nullable(),
  /** The channel that it is about, or null. */
  channelId: idSchema.nullable(),
  /** When what it tells of happened, or happened again. */
  createdAt: timeSchema,
  /** When the person read it, on any device. Null until then. */
  readAt: timeSchema.nullable(),
});

/** The schema of a row of every synced table, by the name of the table. */
export const rowSchemas = {
  post: postRowSchema,
  post_part: postPartRowSchema,
  channel: channelRowSchema,
  post_target: postTargetRowSchema,
  target_part_result: targetPartResultRowSchema,
  notification: notificationRowSchema,
} as const;

export type TableName = keyof typeof rowSchemas;

export const tableNames = Object.keys(rowSchemas) as [
  TableName,
  ...TableName[],
];

/** A row of the synced table `Table`. */
export type Row<Table extends TableName> = z.infer<(typeof rowSchemas)[Table]>;
