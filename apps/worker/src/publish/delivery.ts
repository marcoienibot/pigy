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
 * The ID of the run of the workflow that carries a delivery: the ID of the
 * workspace, the ID of the target, and the time at which the workspace
 * began the delivery, in milliseconds since the epoch.
 *
 * The runs of all workspaces share their IDs, and the platform takes an ID
 * once: a second run under an ID that is taken is not created. So the ID
 * has to be this delivery's and nobody else's. The target alone does not
 * do that, and neither does its attempt: a client makes up the ID of a
 * target, which is unique within its workspace only, and a target that is
 * deleted and added again under the same ID begins at its first attempt
 * again. The workspace tells its own runs from those of every other
 * workspace, and the time one delivery of the workspace from every other:
 * a workspace runs each mutation at a later time than the one before, and
 * the time of the mutation that begins a delivery is the one meant here.
 *
 * So a delivery has one run however often its start is tried, and a run
 * that is found under this ID is the delivery's own.
 *
 * Workflows takes an ID of at most 100 characters, of letters, digits, `-`
 * and `_`. This one has 87: two UUIDs of 36 characters, 13 digits and two
 * hyphens.
 */
export function deliveryInstanceId(run: {
  workspaceId: string;
  targetId: string;
  startedAt: number;
}): string {
  return `${run.workspaceId}-${run.targetId}-${run.startedAt}`;
}

/**
 * What a target says when its delivery ended and nobody knows how far it
 * got: a step failed in a way that is pigy's own, or the workflow stopped
 * without a word.
 */
export const lostTrackMessage =
  "Something went wrong in pigy while this was being sent, and it cannot tell how far it got. Look at the account before you try again.";

/**
 * What a target says when a step that asked a network to publish was cut
 * off, on a network where pigy can neither look for the post nor ask a
 * second time without posting twice: nobody knows whether the request
 * went out.
 */
export const cutOffMessage =
  "pigy was interrupted while it sent this, and this network gives it no way to find out whether the post arrived. Look at the account before you try again.";

/**
 * Lets go of what the platform handed out for a run of the workflow. Such
 * a handle keeps a connection to the run until it is let go, or until the
 * runtime gets round to collecting it, which it warns about.
 */
export function release(handle: object): void {
  (handle as Partial<Disposable>)[Symbol.dispose]?.();
}
