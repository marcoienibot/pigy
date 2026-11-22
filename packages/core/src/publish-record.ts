import { z } from "zod";
import { networks } from "./network/network.ts";

/**
 * The record of what a workspace was asked to publish: every request to
 * send a post to its accounts, where it came from, and how each delivery
 * that it asked for ended. The object of the workspace keeps it, where no
 * client syncs it, and the Settings of the app show it to the owner. It
 * names a post and an account by their IDs and holds no text of a post
 * and no secret: `PLAN.md` section 16, "The record of publishing".
 */

/**
 * Where a request to publish came from.
 *
 * - `app`: a device of the person, which published a post or tried a
 *   delivery again.
 * - `api`: the public API, with the ID of the key that it was called with.
 * - `schedule`: the time that somebody chose for a post, which has come.
 * - `queue`: a slot of the posting schedule, which has come.
 */
export const publishSources = ["app", "api", "schedule", "queue"] as const;

export type PublishSource = (typeof publishSources)[number];

/**
 * How a delivery that a request asked for ended: as the status of its
 * target says, or `disconnected` for one that ended because the account
 * was disconnected while it waited or was under way.
 */
export const deliveryOutcomes = [
  "sent",
  "error",
  "uncertain",
  "disconnected",
] as const;

export type DeliveryOutcome = (typeof deliveryOutcomes)[number];

/**
 * How long a request is kept in the record, in milliseconds: 90 days. An
 * older one is not shown, and goes with the next request that is recorded.
 */
export const publishRecordLifetimeMs = 90 * 24 * 60 * 60 * 1000;

/**
 * How many deliveries the record keeps at most, the requests that asked
 * for them together: the oldest go first. A post to four accounts is four.
 */
export const maxPublishRecordDeliveries = 2000;

/** How many requests one answer of the record has at most. */
export const publishRecordPageSize = 50;

/**
 * One of `values`, or `other` for a value that a later release of pigy
 * has added: a device reads the answers of the next release with the app
 * that it has, and must not refuse a whole record for one word that it
 * does not know.
 */
const oneOf = <const Values extends readonly [string, ...string[]]>(
  values: Values,
) =>
  z
    .enum(values)
    .or(z.string().transform((): "other" => "other"))
    .catch("other");

/** A time, in milliseconds since the Unix epoch. */
const timeSchema = z.number().int().nonnegative();

/** One request to publish, as the record has it. */
export const publishRequestSchema = z.object({
  /** The post that was to be sent. It may have been deleted since. */
  postId: z.string(),
  /** When the request was made, by the time of the workspace. */
  requestedAt: timeSchema,
  source: oneOf(publishSources),
  /** The ID of the API key of a request of the API, and null otherwise. */
  apiKeyId: z.string().nullable(),
  /** The deliveries that it asked for, one for each account. */
  deliveries: z.array(
    z.object({
      targetId: z.string(),
      /** The account. It may have been disconnected since. */
      channelId: z.string(),
      network: oneOf(networks),
      /** How it ended, or null while it is on its way. */
      outcome: oneOf(deliveryOutcomes).nullable(),
      /** When it ended, or null while it is on its way. */
      endedAt: timeSchema.nullable(),
    }),
  ),
});

export type PublishRequest = z.infer<typeof publishRequestSchema>;

/**
 * An answer of `GET /api/workspaces/<workspace ID>/publish-record`: the
 * newest requests, before `before` if the question named a time. `more`
 * says whether older ones are kept, for which the client asks with the
 * time of the last one here.
 */
export const publishRecordResponseSchema = z.object({
  requests: z.array(publishRequestSchema),
  more: z.boolean(),
});

export type PublishRecordResponse = z.infer<typeof publishRecordResponseSchema>;

/** The query of that route: a time to begin before, if any. */
export const publishRecordQuerySchema = z.strictObject({
  before: z.coerce.number().int().nonnegative().optional(),
});
