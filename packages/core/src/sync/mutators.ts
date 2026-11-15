import { z } from "zod";
import { idSchema } from "../id.ts";
import { limitsSchema } from "../network/limits.ts";
import {
  channelRowSchema,
  inReadingOrder,
  maxPartTextLength,
  type Row,
  targetLimits,
  targetPartResultRowSchema,
  targetStatusSchema,
} from "./tables.ts";
import type { Transaction } from "./transaction.ts";

/**
 * The mutators: every way to change the synced data of a workspace. A client
 * sends the name and the arguments of a mutation, never rows. The server runs
 * the mutator and its result is what counts. A client may run the same
 * mutator on its local copy first, to show the change at once.
 *
 * Some mutators are the server's own: a client that sends one is refused.
 * They change rows that stand for something only the server has, such as a
 * channel, which is nothing without its credentials.
 *
 * A mutator is synchronous and uses nothing but its arguments and the
 * transaction, so that it does the same thing wherever it runs. It either
 * completes or throws: whoever runs it discards the writes of a mutator that
 * threw.
 */

/** Why a mutation was refused. Clients branch on it. */
export const rejectionCodeSchema = z.enum([
  /** No mutator has this name. */
  "unknown_mutation",
  /** The arguments are not what the mutator takes. */
  "invalid_arguments",
  /** A row with this ID exists already. */
  "already_exists",
  /** The row that the mutation is about does not exist, or no longer. */
  "not_found",
  /** The post is past being a draft, so it can no longer be edited. */
  "not_a_draft",
  /** The post has no channel to go to. */
  "no_channels",
  /** The post is on its way to its channels, and stays until it has ended. */
  "sending",
  /** The delivery has not failed, so there is nothing to try again. */
  "not_failed",
  /**
   * The delivery that the server reports on is not under way: it has
   * ended, or has been begun anew since.
   */
  "not_current",
  /** The mutation is one that only the server runs. */
  "not_allowed",
  /** The server failed. The details are in its logs. */
  "internal_error",
]);

export type RejectionCode = z.infer<typeof rejectionCodeSchema>;

/** Thrown by a mutator that refuses to run, with the reason. */
export class MutationRejected extends Error {
  constructor(
    readonly code: RejectionCode,
    /** For people. */
    message: string,
  ) {
    super(message);
  }
}

/** Who asks for a mutation: a client over its socket, or the server itself. */
export type MutationSource = "client" | "server";

function mutator<Schema extends z.ZodType>(
  schema: Schema,
  run: (tx: Transaction, args: z.output<Schema>) => void,
  { serverOnly = false } = {},
) {
  return {
    schema,
    /** True for a mutator that a client may not ask for. */
    serverOnly,
    /** Checks `args` and runs the mutator. */
    apply(tx: Transaction, args: unknown): void {
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        const [issue] = parsed.error.issues;
        const path = issue?.path.join(".");
        const message = issue?.message ?? "The arguments are invalid";
        throw new MutationRejected(
          "invalid_arguments",
          path ? `${path}: ${message}` : message,
        );
      }
      run(tx, parsed.data);
    },
  };
}

const partTextSchema = z.string().max(maxPartTextLength);

/** The post with this ID. A mutation about one that is gone is rejected. */
function existingPost(tx: Transaction, id: string): Row<"post"> {
  const post = tx.get("post", id);
  if (!post) {
    throw new MutationRejected("not_found", "This post no longer exists");
  }
  return post;
}

/**
 * Gives a post the status that follows from its targets, when one of them
 * has changed: `sending` while any of them is on its way or waits its
 * turn, `sent` when all of them are sent, and `error` when all have ended
 * and not all of them well. A post whose targets ended differently is in
 * `error`: its targets say which of them arrived.
 */
function settle(tx: Transaction, postId: string): void {
  const post = tx.get("post", postId);
  if (!post) return;
  const targets = tx.find("post_target", "postId", postId);
  const status = targets.some(
    (target) => target.status === "queued" || target.status === "sending",
  )
    ? "sending"
    : targets.every((target) => target.status === "sent")
      ? "sent"
      : "error";
  if (status !== post.status) {
    tx.put("post", { ...post, status, updatedAt: tx.now });
  }
}

/**
 * The target that the server reports on: the one with this ID, if it is on
 * its way in the attempt that the report is from. A report that comes late
 * is rejected: the delivery was ended since, by a disconnect for example,
 * or ended and begun anew.
 */
function currentTarget(
  tx: Transaction,
  id: string,
  attempt: number,
): Row<"post_target"> {
  const target = tx.get("post_target", id);
  if (target?.status !== "sending" || target.attempt !== attempt) {
    throw new MutationRejected(
      "not_current",
      "This delivery is no longer under way",
    );
  }
  return target;
}

// What a target is told when its account is disconnected under it.
const disconnectedMessage =
  "The account was disconnected before the post was sent.";

export const mutators = {
  /**
   * Creates a draft with its first part. A post always has at least one
   * part. The text may be empty.
   */
  "post.create": mutator(
    z.strictObject({ id: idSchema, partId: idSchema, text: partTextSchema }),
    (tx, { id, partId, text }) => {
      if (tx.get("post", id) || tx.get("post_part", partId)) {
        throw new MutationRejected(
          "already_exists",
          "This post exists already",
        );
      }
      tx.put("post", {
        id,
        status: "draft",
        createdAt: tx.now,
        updatedAt: tx.now,
      });
      tx.put("post_part", { id: partId, postId: id, position: 0, text });
    },
  ),

  /** Replaces the text of one part of a draft. */
  "part.setText": mutator(
    z.strictObject({ id: idSchema, text: partTextSchema }),
    (tx, { id, text }) => {
      const part = tx.get("post_part", id);
      const post = part && tx.get("post", part.postId);
      if (!part || !post) {
        throw new MutationRejected("not_found", "This post no longer exists");
      }
      if (post.status !== "draft") {
        throw new MutationRejected("not_a_draft", "Only a draft can be edited");
      }
      tx.put("post_part", { ...part, text });
      tx.put("post", { ...post, updatedAt: tx.now });
    },
  ),

  /**
   * Deletes a post with its parts, its targets and what they published.
   * Deleting a post that does not exist does nothing and is not an error:
   * two devices can delete the same post.
   *
   * A post that is being sent stays until all its targets have ended.
   * Deleted in the middle, it would leave posts on the networks that pigy
   * knows nothing of.
   */
  "post.delete": mutator(z.strictObject({ id: idSchema }), (tx, { id }) => {
    if (tx.get("post", id)?.status === "sending") {
      throw new MutationRejected(
        "sending",
        "A post cannot be deleted while it is being sent",
      );
    }
    // What refers to something goes before it: a part cannot be without
    // its post, and a result not without its target and its part.
    for (const target of tx.find("post_target", "postId", id)) {
      for (const result of tx.find(
        "target_part_result",
        "targetId",
        target.id,
      )) {
        tx.delete("target_part_result", result.id);
      }
      tx.delete("post_target", target.id);
    }
    for (const part of tx.find("post_part", "postId", id)) {
      tx.delete("post_part", part.id);
    }
    tx.delete("post", id);
  }),

  /**
   * Chooses a channel for a draft to go to. Does nothing if the draft goes
   * there already: two devices can choose the same channel, and the target
   * that came first stays.
   */
  "target.add": mutator(
    z.strictObject({ id: idSchema, postId: idSchema, channelId: idSchema }),
    (tx, { id, postId, channelId }) => {
      const post = existingPost(tx, postId);
      if (post.status !== "draft") {
        throw new MutationRejected(
          "not_a_draft",
          "Only a draft can change where it goes",
        );
      }
      if (!tx.get("channel", channelId)) {
        throw new MutationRejected(
          "not_found",
          "This account is no longer connected",
        );
      }
      const chosen = tx
        .find("post_target", "postId", postId)
        .some((target) => target.channelId === channelId);
      if (chosen) return;
      if (tx.get("post_target", id)) {
        throw new MutationRejected(
          "already_exists",
          "This target exists already",
        );
      }
      tx.put("post_target", {
        id,
        postId,
        channelId,
        status: "pending",
        attempt: 0,
        error: null,
        queuedAt: null,
        sentAt: null,
      });
      tx.put("post", { ...post, updatedAt: tx.now });
    },
  ),

  /**
   * Takes a channel back from where a draft goes. The target is named by
   * its post and its channel, not by its ID: of two devices that chose the
   * channel, one has made up an ID that the server never took. Does nothing
   * if the draft does not go there.
   */
  "target.remove": mutator(
    z.strictObject({ postId: idSchema, channelId: idSchema }),
    (tx, { postId, channelId }) => {
      const post = existingPost(tx, postId);
      if (post.status !== "draft") {
        throw new MutationRejected(
          "not_a_draft",
          "Only a draft can change where it goes",
        );
      }
      const target = tx
        .find("post_target", "postId", postId)
        .find((candidate) => candidate.channelId === channelId);
      if (!target) return;
      tx.delete("post_target", target.id);
      tx.put("post", { ...post, updatedAt: tx.now });
    },
  ),

  /**
   * Asks for a draft to be sent to its channels now. The post is `sending`
   * from here on and can no longer be edited, and its targets wait their
   * turn. The server takes it from there: a client sees the targets change
   * as they go out.
   */
  "post.publish": mutator(z.strictObject({ id: idSchema }), (tx, { id }) => {
    const post = existingPost(tx, id);
    if (post.status !== "draft") {
      throw new MutationRejected(
        "not_a_draft",
        "Only a draft can be published",
      );
    }
    const targets = tx.find("post_target", "postId", id);
    if (targets.length === 0) {
      throw new MutationRejected(
        "no_channels",
        "Choose an account to publish to first",
      );
    }
    for (const target of targets) {
      tx.put("post_target", { ...target, status: "queued", queuedAt: tx.now });
    }
    tx.put("post", { ...post, status: "sending", updatedAt: tx.now });
  }),

  /**
   * Asks for a delivery that failed to be tried again. It goes on from the
   * parts that are published, at the end of the queue of its channel, and
   * its post is `sending` again.
   */
  "target.retry": mutator(z.strictObject({ id: idSchema }), (tx, { id }) => {
    const target = tx.get("post_target", id);
    if (!target) {
      throw new MutationRejected("not_found", "This post no longer exists");
    }
    if (target.status !== "error" && target.status !== "uncertain") {
      throw new MutationRejected(
        "not_failed",
        "Only a delivery that has failed can be tried again",
      );
    }
    if (!tx.get("channel", target.channelId)) {
      throw new MutationRejected(
        "not_found",
        "This account is no longer connected",
      );
    }
    tx.put("post_target", {
      ...target,
      status: "queued",
      error: null,
      queuedAt: tx.now,
    });
    settle(tx, target.postId);
  }),

  /**
   * Stores the account that somebody has just connected, as a channel that
   * is good to use. An account has one channel: if the workspace has one
   * for it already, that channel is brought up to date and keeps its ID,
   * and `id` is not used. The server runs this when a network has handed it
   * the access to the account, and stores that access with the channel.
   *
   * `limits` is what the network said the account may post, or null if it
   * could not be asked: a channel that has limits from before keeps them
   * then.
   */
  "channel.connect": mutator(
    channelRowSchema.omit({
      status: true,
      connectedAt: true,
      limitsCheckedAt: true,
    }),
    (tx, channel) => {
      const existing = tx
        .find("channel", "accountId", channel.accountId)
        .find(({ network }) => network === channel.network);
      if (!existing && tx.get("channel", channel.id)) {
        throw new MutationRejected(
          "already_exists",
          "This channel exists already",
        );
      }
      tx.put("channel", {
        ...channel,
        id: existing?.id ?? channel.id,
        status: "connected",
        connectedAt: tx.now,
        limits: channel.limits ?? existing?.limits ?? null,
        limitsCheckedAt: channel.limits
          ? tx.now
          : (existing?.limitsCheckedAt ?? null),
      });
    },
    { serverOnly: true },
  ),

  /**
   * Stores what the account of a channel may post, as its network has just
   * said. The server runs this when it has asked the network again.
   */
  "channel.setLimits": mutator(
    z.strictObject({ id: idSchema, limits: limitsSchema }),
    (tx, { id, limits }) => {
      const channel = tx.get("channel", id);
      if (!channel) {
        throw new MutationRejected(
          "not_found",
          "This account is no longer connected",
        );
      }
      tx.put("channel", { ...channel, limits, limitsCheckedAt: tx.now });
    },
    { serverOnly: true },
  ),

  /**
   * Stores when the access of a channel ends now that the server has
   * renewed its credentials, where the network has that. It keeps the new
   * credentials with the channel in the same step.
   */
  "channel.renew": mutator(
    channelRowSchema.pick({ id: true, expiresAt: true }),
    (tx, { id, expiresAt }) => {
      const channel = tx.get("channel", id);
      if (!channel) {
        throw new MutationRejected(
          "not_found",
          "This account is no longer connected",
        );
      }
      tx.put("channel", { ...channel, expiresAt });
    },
    { serverOnly: true },
  ),

  /**
   * Removes a channel, and with it the access that the server keeps for
   * it. Does nothing if the channel is gone.
   *
   * The posts that were to go to the channel no longer do. A draft loses
   * the target. A target that waits or is on its way fails, with what it
   * has published so far. What has ended stays as it is, for the record:
   * its `channelId` then names a channel that is gone.
   */
  "channel.disconnect": mutator(
    z.strictObject({ id: idSchema }),
    (tx, { id }) => {
      for (const target of tx.find("post_target", "channelId", id)) {
        if (target.status === "pending") {
          tx.delete("post_target", target.id);
        } else if (target.status === "queued" || target.status === "sending") {
          tx.put("post_target", {
            ...target,
            status: "error",
            error: disconnectedMessage,
          });
          settle(tx, target.postId);
        }
      }
      tx.delete("channel", id);
    },
    { serverOnly: true },
  ),

  /**
   * Begins a delivery that has waited its turn, or begins one anew that is
   * tried again: the target is `sending` in a new attempt. The server runs
   * this when no other delivery to the channel is under way, which is also
   * checked here: an adapter cannot tell two deliveries to one account
   * apart that go out together.
   */
  "target.start": mutator(
    z.strictObject({ id: idSchema }),
    (tx, { id }) => {
      const target = tx.get("post_target", id);
      const busy =
        target &&
        tx
          .find("post_target", "channelId", target.channelId)
          .some((other) => other.status === "sending");
      if (target?.status !== "queued" || busy) {
        throw new MutationRejected(
          "not_current",
          "This delivery cannot begin now",
        );
      }
      tx.put("post_target", {
        ...target,
        status: "sending",
        attempt: target.attempt + 1,
      });
    },
    { serverOnly: true },
  ),

  /**
   * Records the parts that a delivery has published so far, in the order
   * of the post: where each stands on the network. A part that is recorded
   * already keeps its row, and the `id` that is passed for it is not used.
   */
  "target.progress": mutator(
    z.strictObject({
      id: idSchema,
      attempt: z.number().int().positive(),
      parts: z.array(
        targetPartResultRowSchema.pick({ id: true, remoteId: true, url: true }),
      ),
    }),
    (tx, { id, attempt, parts }) => {
      const target = currentTarget(tx, id, attempt);
      const postParts = inReadingOrder(
        tx.find("post_part", "postId", target.postId),
      );
      const recorded = new Set(
        tx
          .find("target_part_result", "targetId", id)
          .map((result) => result.partId),
      );
      parts.forEach((published, index) => {
        const part = postParts[index];
        if (!part) {
          throw new MutationRejected(
            "invalid_arguments",
            "The post has fewer parts than were published",
          );
        }
        if (recorded.has(part.id)) return;
        if (tx.get("target_part_result", published.id)) {
          throw new MutationRejected(
            "already_exists",
            "This result exists already",
          );
        }
        tx.put("target_part_result", {
          ...published,
          targetId: id,
          partId: part.id,
        });
      });
    },
    { serverOnly: true },
  ),

  /**
   * Ends a delivery: every part is published, or it has failed, with the
   * reason for the person. `reconnect` says that the network no longer
   * takes the access of the channel, which then needs connecting again.
   * The post leaves `sending` when the last of its targets has ended.
   */
  "target.end": mutator(
    z.discriminatedUnion("status", [
      z.strictObject({
        id: idSchema,
        attempt: z.number().int().positive(),
        status: z.literal(targetStatusSchema.enum.sent),
      }),
      z.strictObject({
        id: idSchema,
        attempt: z.number().int().positive(),
        status: targetStatusSchema.extract(["error", "uncertain"]),
        error: z.string().min(1).max(targetLimits.errorLength),
        reconnect: z.boolean(),
      }),
    ]),
    (tx, end) => {
      const target = currentTarget(tx, end.id, end.attempt);
      tx.put("post_target", {
        ...target,
        status: end.status,
        error: end.status === "sent" ? null : end.error,
        sentAt: end.status === "sent" ? tx.now : null,
      });
      if (end.status !== "sent" && end.reconnect) {
        const channel = tx.get("channel", target.channelId);
        if (channel) {
          tx.put("channel", { ...channel, status: "needs_reconnect" });
        }
      }
      settle(tx, target.postId);
    },
    { serverOnly: true },
  ),
};

export type MutatorName = keyof typeof mutators;

/** The arguments of the mutator `Name`. */
export type MutatorArgs<Name extends MutatorName> = z.input<
  (typeof mutators)[Name]["schema"]
>;

/**
 * Runs the mutation `name` with `args` in `tx`, for `source`. Throws
 * `MutationRejected` if there is no such mutator, if it is one that
 * `source` may not ask for, if the arguments are not what it takes, or if
 * it refuses. Then, and when anything else is thrown, the caller has to
 * discard what the mutation wrote to `tx`.
 */
export function applyMutation(
  tx: Transaction,
  name: string,
  args: unknown,
  source: MutationSource,
): void {
  if (!Object.hasOwn(mutators, name)) {
    throw new MutationRejected(
      "unknown_mutation",
      `There is no mutation named ${JSON.stringify(name)}`,
    );
  }
  const mutator = mutators[name as MutatorName];
  if (mutator.serverOnly && source === "client") {
    throw new MutationRejected(
      "not_allowed",
      `Only the server runs ${JSON.stringify(name)}`,
    );
  }
  mutator.apply(tx, args);
}
