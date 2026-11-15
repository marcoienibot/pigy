import { z } from "zod";
import { idSchema } from "../id.ts";
import { maxPartTextLength } from "./tables.ts";
import type { Transaction } from "./transaction.ts";

/**
 * The mutators: every way to change the synced data of a workspace. A client
 * sends the name and the arguments of a mutation, never rows. The server runs
 * the mutator and its result is what counts. A client may run the same
 * mutator on its local copy first, to show the change at once.
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

function mutator<Schema extends z.ZodType>(
  schema: Schema,
  run: (tx: Transaction, args: z.output<Schema>) => void,
) {
  return {
    schema,
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
};

export type MutatorName = keyof typeof mutators;

/** The arguments of the mutator `Name`. */
export type MutatorArgs<Name extends MutatorName> = z.input<
  (typeof mutators)[Name]["schema"]
>;

/**
 * Runs the mutation `name` with `args` in `tx`. Throws `MutationRejected` if
 * there is no such mutator, if the arguments are not what it takes, or if it
 * refuses. Then, and when anything else is thrown, the caller has to discard
 * what the mutation wrote to `tx`.
 */
export function applyMutation(
  tx: Transaction,
  name: string,
  args: unknown,
): void {
  if (!Object.hasOwn(mutators, name)) {
    throw new MutationRejected(
      "unknown_mutation",
      `There is no mutation named ${JSON.stringify(name)}`,
    );
  }
  mutators[name as MutatorName].apply(tx, args);
}
