import { environmentSchema, idSchema } from "@pigy/core";
import { z } from "zod";

/**
 * What the Durable Object of a workspace and the publishing workflow agree
 * on: a delivery is one attempt at sending a post to one channel, and one
 * run of the workflow carries it.
 */

/**
 * What a run of the workflow is started with. It is stored by the platform
 * with the run, so it names things and holds nothing of them: no text of a
 * post and nothing of a channel.
 */
export const deliveryParamsSchema = z.strictObject({
  /** The workspace as its Durable Object knows itself. */
  workspace: z.strictObject({
    id: z.string().min(1),
    ownerId: z.string().min(1),
    environment: environmentSchema,
  }),
  targetId: idSchema,
  attempt: z.number().int().positive(),
});

export type DeliveryParams = z.infer<typeof deliveryParamsSchema>;

/**
 * The ID of the run of the workflow that carries a delivery. It is made of
 * the target and the attempt, so that a delivery has one run however often
 * its start is tried, and a new attempt gets a run of its own: the platform
 * takes an ID once.
 */
export function deliveryInstanceId(run: {
  targetId: string;
  attempt: number;
}): string {
  return `${run.targetId}-${run.attempt}`;
}

/**
 * What a target says when its delivery ended and nobody knows how far it
 * got: a step failed in a way that is pigy's own, or the workflow stopped
 * without a word.
 */
export const lostTrackMessage =
  "Something went wrong in pigy while this was being sent, and it cannot tell how far it got. Look at the account before you try again.";

/**
 * Lets go of what the platform handed out for a run of the workflow. Such
 * a handle keeps a connection to the run until it is let go, or until the
 * runtime gets round to collecting it, which it warns about.
 */
export function release(handle: object): void {
  (handle as Partial<Disposable>)[Symbol.dispose]?.();
}
