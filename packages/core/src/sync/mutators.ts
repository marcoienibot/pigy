import { z } from "zod";
import { idSchema } from "../id.ts";
import { limitsSchema } from "../network/limits.ts";
import { channelRowSchema, maxPartTextLength } from "./tables.ts";
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
   * Deletes a post with its parts. Deleting a post that does not exist does
   * nothing and is not an error: two devices can delete the same post.
   */
  "post.delete": mutator(z.strictObject({ id: idSchema }), (tx, { id }) => {
    // The parts go first: a part cannot be without its post.
    for (const part of tx.find("post_part", "postId", id)) {
      tx.delete("post_part", part.id);
    }
    tx.delete("post", id);
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
   * Removes a channel, and with it the access that the server keeps for
   * it. Does nothing if the channel is gone.
   */
  "channel.disconnect": mutator(
    z.strictObject({ id: idSchema }),
    (tx, { id }) => {
      tx.delete("channel", id);
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
