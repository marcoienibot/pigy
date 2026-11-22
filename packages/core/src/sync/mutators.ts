import { z } from "zod";
import { idSchema } from "../id.ts";
import { limitsSchema } from "../network/limits.ts";
import {
  channelRowSchema,
  inReadingOrder,
  maxOwnTextLength,
  maxParts,
  maxPartTextLength,
  partsFor,
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
  /** The part is the only one of its text, which has to keep one. */
  "last_part",
  /** The text has as many parts as a text can have. */
  "too_many_parts",
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

/** The post with this ID, which has to be a draft: only a draft is edited. */
function draft(tx: Transaction, id: string): Row<"post"> {
  const post = existingPost(tx, id);
  if (post.status !== "draft") {
    throw new MutationRejected("not_a_draft", "Only a draft can be edited");
  }
  return post;
}

/** The target of the post `postId` that goes to `channelId`, if any. */
function targetTo(
  tx: Transaction,
  postId: string,
  channelId: string,
): Row<"post_target"> | undefined {
  return tx
    .find("post_target", "postId", postId)
    .find((target) => target.channelId === channelId);
}

/**
 * The parts of one text, in the order they are read in: those of the post
 * `postId` that are written for `targetId`, or the post's own for null.
 */
function textOf(
  tx: Transaction,
  postId: string,
  targetId: string | null,
): Row<"post_part">[] {
  return inReadingOrder(
    tx
      .find("post_part", "postId", postId)
      .filter((part) => part.targetId === targetId),
  );
}

/**
 * Stores `parts` as one text in this order: each gets its place in the
 * list as its position. Only the parts that are new or have moved are
 * written, so a part that stays where it was is no change.
 */
function inOrder(
  tx: Transaction,
  parts: readonly Row<"post_part">[],
  added?: Row<"post_part">,
): void {
  parts.forEach((part, position) => {
    if (part === added || part.position !== position) {
      tx.put("post_part", { ...part, position });
    }
  });
}

/** Removes the text that was written for `targetId`, if there is one. */
function dropOwnText(
  tx: Transaction,
  { id, postId }: Row<"post_target">,
): boolean {
  const written = textOf(tx, postId, id);
  for (const part of written) tx.delete("post_part", part.id);
  return written.length > 0;
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
      tx.put("post_part", {
        id: partId,
        postId: id,
        targetId: null,
        position: 0,
        text,
      });
    },
  ),

  /**
   * Replaces the text of one part of a draft: of its own text, or of the
   * text that is written for one of its accounts.
   */
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
   * Adds a part to a text of a draft: to the post's own, or with
   * `channelId` to the text that is written for that account. The part
   * goes after the part `afterId`, or first for null.
   *
   * A mutation names the part to go after and no position: the order is
   * kept where the mutations are run one after the other, and two devices
   * that add a part at the same place both get theirs in, the later one
   * nearer to the part that both named. If that part is gone by now, or
   * is not of this text, the new one goes to the end: what was typed
   * into it is kept.
   */
  "part.add": mutator(
    z.strictObject({
      id: idSchema,
      postId: idSchema,
      channelId: idSchema.nullable(),
      afterId: idSchema.nullable(),
      text: partTextSchema,
    }),
    (tx, { id, postId, channelId, afterId, text }) => {
      const post = draft(tx, postId);
      if (tx.get("post_part", id)) {
        throw new MutationRejected(
          "already_exists",
          "This part exists already",
        );
      }
      const target =
        channelId === null ? undefined : targetTo(tx, postId, channelId);
      const parts = textOf(tx, postId, target?.id ?? null);
      // A text for an account begins with `target.customize`. One that
      // was dropped since, with its account or without, is not begun
      // anew by a part that was meant for the middle of it.
      if (channelId !== null && parts.length === 0) {
        throw new MutationRejected(
          "not_found",
          "This account no longer has a text of its own",
        );
      }
      if (parts.length >= maxParts) {
        throw new MutationRejected(
          "too_many_parts",
          `A post has at most ${maxParts} parts`,
        );
      }
      const added = {
        id,
        postId,
        targetId: target?.id ?? null,
        position: 0,
        text,
      };
      const after = parts.findIndex((part) => part.id === afterId);
      parts.splice(
        afterId === null ? 0 : after < 0 ? parts.length : after + 1,
        0,
        added,
      );
      inOrder(tx, parts, added);
      tx.put("post", { ...post, updatedAt: tx.now });
    },
  ),

  /**
   * Removes a part from its text. Does nothing if the part is gone: two
   * devices can remove the same part. A text keeps one part: the last one
   * is not removed. The text of an account goes as a whole, with
   * `target.followPost`.
   */
  "part.remove": mutator(z.strictObject({ id: idSchema }), (tx, { id }) => {
    const part = tx.get("post_part", id);
    if (!part) return;
    const post = draft(tx, part.postId);
    const parts = textOf(tx, part.postId, part.targetId);
    if (parts.length === 1) {
      throw new MutationRejected(
        "last_part",
        "The only part of a text cannot be removed",
      );
    }
    tx.delete("post_part", id);
    inOrder(
      tx,
      parts.filter((other) => other.id !== id),
    );
    tx.put("post", { ...post, updatedAt: tx.now });
  }),

  /**
   * Moves a part within its text: to after the part `afterId`, or to the
   * beginning for null. Like `part.add`, it names a part and no position.
   * If the part to go after is gone by now, or is not of this text, the
   * part stays where it is.
   */
  "part.move": mutator(
    z.strictObject({ id: idSchema, afterId: idSchema.nullable() }),
    (tx, { id, afterId }) => {
      const part = tx.get("post_part", id);
      if (!part) {
        throw new MutationRejected("not_found", "This part no longer exists");
      }
      const post = draft(tx, part.postId);
      const parts = textOf(tx, part.postId, part.targetId);
      const others = parts.filter((other) => other.id !== id);
      const after = others.findIndex((other) => other.id === afterId);
      if (afterId !== null && after < 0) return;
      // The row as `textOf` handed it out, so that `inOrder` compares it
      // with the place it had.
      const moved = parts.find((other) => other.id === id);
      if (!moved) return;
      others.splice(afterId === null ? 0 : after + 1, 0, moved);
      if (others.every((other, index) => other === parts[index])) return;
      inOrder(tx, others);
      tx.put("post", { ...post, updatedAt: tx.now });
    },
  ),

  /**
   * Deletes a post with its parts, those that are written for one account
   * included, its targets and what they published.
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
    // What refers to something goes before it: a result cannot be without
    // its target and its part, a part that is written for a target not
    // without that target, and none of them without the post.
    const targets = tx.find("post_target", "postId", id);
    for (const target of targets) {
      for (const result of tx.find(
        "target_part_result",
        "targetId",
        target.id,
      )) {
        tx.delete("target_part_result", result.id);
      }
    }
    for (const part of tx.find("post_part", "postId", id)) {
      tx.delete("post_part", part.id);
    }
    for (const target of targets) tx.delete("post_target", target.id);
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
      // The text that was written for the account goes with the choice.
      dropOwnText(tx, target);
      tx.delete("post_target", target.id);
      tx.put("post", { ...post, updatedAt: tx.now });
    },
  ),

  /**
   * Gives an account of a draft a text of its own, in place of the post's:
   * `parts`, in this order, which the app fills with the post's text as it
   * is, for the person to change. From then on the account gets these
   * parts, however many there are, and the post's own text goes to the
   * other accounts.
   *
   * The whole text comes in one mutation, so that an account never has
   * half of one, and so that of two devices that begin one, one wins as a
   * whole: does nothing if the account has a text of its own already. The
   * account is named by its channel, like in `target.remove`.
   */
  "target.customize": mutator(
    z.strictObject({
      postId: idSchema,
      channelId: idSchema,
      parts: z
        .array(z.strictObject({ id: idSchema, text: partTextSchema }))
        .min(1)
        .max(maxParts)
        .refine(
          (parts) =>
            parts.reduce((length, { text }) => length + text.length, 0) <=
            maxOwnTextLength,
          `The text is longer than ${maxOwnTextLength} characters`,
        ),
    }),
    (tx, { postId, channelId, parts }) => {
      const post = draft(tx, postId);
      const target = targetTo(tx, postId, channelId);
      if (!target) {
        throw new MutationRejected(
          "not_found",
          "The post no longer goes to this account",
        );
      }
      if (textOf(tx, postId, target.id).length > 0) return;
      parts.forEach(({ id, text }, position) => {
        if (
          tx.get("post_part", id) ||
          parts.findIndex((part) => part.id === id) !== position
        ) {
          throw new MutationRejected(
            "already_exists",
            "This part exists already",
          );
        }
        tx.put("post_part", {
          id,
          postId,
          targetId: target.id,
          position,
          text,
        });
      });
      tx.put("post", { ...post, updatedAt: tx.now });
    },
  ),

  /**
   * Takes the text that was written for an account away again: the
   * account gets the post's own text, like the others. Does nothing if it
   * does so already, or if the post does not go there.
   */
  "target.followPost": mutator(
    z.strictObject({ postId: idSchema, channelId: idSchema }),
    (tx, { postId, channelId }) => {
      const post = draft(tx, postId);
      const target = targetTo(tx, postId, channelId);
      if (!target || !dropOwnText(tx, target)) return;
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
   * the target, with the text that was written for it. A target that waits or is on its way fails, with what it
   * has published so far. What has ended stays as it is, for the record:
   * its `channelId` then names a channel that is gone.
   */
  "channel.disconnect": mutator(
    z.strictObject({ id: idSchema }),
    (tx, { id }) => {
      for (const target of tx.find("post_target", "channelId", id)) {
        if (target.status === "pending") {
          dropOwnText(tx, target);
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
   * of the text that the target gets, the post's or its own: where each stands on the network. A part that is recorded
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
      // The parts that the target gets: its own, if it has any.
      const postParts = partsFor(
        tx.find("post_part", "postId", target.postId),
        id,
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
   * reason for the person. The post leaves `sending` when the last of its
   * targets has ended.
   *
   * `refusedConnection` says whether the network has refused the access
   * of the channel, and which access: the `connectedAt` of the channel
   * that the refused credentials were read with, or null if none were
   * refused. The channel then needs connecting again, unless it has been
   * connected again since. The end of a delivery can be recorded long
   * after its network refused, and must not mark a connection that the
   * delivery has never tried.
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
        refusedConnection: channelRowSchema.shape.connectedAt.nullable(),
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
      if (end.status !== "sent" && end.refusedConnection !== null) {
        const channel = tx.get("channel", target.channelId);
        // The time of a connection names it: no two mutations of a
        // workspace are run at the same time.
        if (channel?.connectedAt === end.refusedConnection) {
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
