import { z } from "zod";
import { idSchema } from "../id.ts";

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

/** The schema of a row of every synced table, by the name of the table. */
export const rowSchemas = {
  post: postRowSchema,
  post_part: postPartRowSchema,
} as const;

export type TableName = keyof typeof rowSchemas;

export const tableNames = Object.keys(rowSchemas) as [
  TableName,
  ...TableName[],
];

/** A row of the synced table `Table`. */
export type Row<Table extends TableName> = z.infer<(typeof rowSchemas)[Table]>;
