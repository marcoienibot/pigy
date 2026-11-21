import {
  environments,
  type MutatorArgs,
  type MutatorName,
  type Workspace,
} from "@pigy/core";
import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { workspaces } from "../db/schema.ts";
import type { Bindings } from "../env.ts";
import type {
  ChannelAccess,
  ConnectChannelCall,
  ConnectChannelOutcome,
  Delivery,
  DeliveryRun,
  DisconnectChannelOutcome,
  MutationOutcome,
  RenewedChannelAccess,
  StepBegun,
  StoredChannelAccess,
  WorkspaceIdentity,
} from "./store.ts";

/**
 * The Worker's side of workspaces: which there are, whose they are, and the
 * only ways into their Durable Objects: `connectWorkspace` for a client,
 * and for the Worker's own code `mutateWorkspace`, `connectChannel`,
 * `disconnectChannel` and `channelAccess`, and what the publishing
 * workflow asks and reports: `deliveryOf`, `aboutToSend`, `stepBegins`,
 * `recordProgress` and `renewChannelAccess`.
 */

/**
 * The workspaces of a user, one per environment, `live` first. They are
 * created the first time anybody asks for them.
 */
export async function workspacesOf(
  db: DrizzleD1Database,
  userId: string,
  now: Date,
): Promise<Workspace[]> {
  const ofUser = db
    .select({ id: workspaces.id, environment: workspaces.environment })
    .from(workspaces)
    .where(eq(workspaces.ownerId, userId));
  let rows = await ofUser;
  if (rows.length < environments.length) {
    // Two requests can get here at the same time. The unique index lets
    // only one of them create each workspace, and both read what is there
    // afterwards.
    [, rows] = await db.batch([
      db
        .insert(workspaces)
        .values(
          environments.map((environment) => ({
            id: crypto.randomUUID(),
            ownerId: userId,
            environment,
            createdAt: now,
          })),
        )
        .onConflictDoNothing(),
      ofUser,
    ]);
  }
  return rows.sort(
    (a, b) =>
      environments.indexOf(a.environment) - environments.indexOf(b.environment),
  );
}

/** The workspace with this ID, if it is one of `userId`'s. */
export async function ownWorkspace(
  db: DrizzleD1Database,
  id: string,
  userId: string,
): Promise<WorkspaceIdentity | undefined> {
  const [workspace] = await db
    .select({
      id: workspaces.id,
      ownerId: workspaces.ownerId,
      environment: workspaces.environment,
    })
    .from(workspaces)
    // The owner is part of the question, so that the answer for somebody
    // else's workspace is the same as for one that does not exist.
    .where(and(eq(workspaces.id, id), eq(workspaces.ownerId, userId)));
  return workspace;
}

/**
 * Opens a WebSocket to the object of `workspace` and returns its answer: a
 * 101 with the socket, a 429 if the workspace has too many open, or a 403 if
 * the object holds another workspace than `workspace`.
 *
 * The request is made here and holds nothing but the workspace. The request
 * of the client never reaches the object, so no header of it can pass for
 * something that the Worker said.
 */
export function connectWorkspace(
  namespace: Bindings["WORKSPACE"],
  workspace: WorkspaceIdentity,
): Promise<Response> {
  // The host is never resolved: the request goes to the object.
  const url = new URL("https://workspace.invalid/");
  url.searchParams.set("id", workspace.id);
  url.searchParams.set("ownerId", workspace.ownerId);
  url.searchParams.set("environment", workspace.environment);
  return namespace
    .getByName(workspace.id)
    .fetch(url, { headers: { Upgrade: "websocket" } });
}

/**
 * Runs the mutator `name` in `workspace` on behalf of the Worker itself, for
 * code that changes a workspace without a client, such as the REST API. The
 * caller answers for `workspace` being the one it may change. Clients that
 * are connected receive the change at once.
 *
 * A call can fail on its way back, after the object has made the change,
 * and the caller cannot tell. Called again, it would run the mutator a
 * second time. A caller that tries again therefore passes a `key`, which
 * names the call: the object carries a call with a key out once, and
 * answers every repeat of it with the outcome of the first, for 30 days.
 * The same key must mean the same call, and no other, within its
 * workspace.
 */
export async function mutateWorkspace<Name extends MutatorName>(
  namespace: Bindings["WORKSPACE"],
  workspace: WorkspaceIdentity,
  name: Name,
  args: MutatorArgs<Name>,
  key?: string,
): Promise<MutationOutcome> {
  const outcome = await namespace
    .getByName(workspace.id)
    .mutate(workspace, name, args, key);
  if (!outcome) throw foreign(workspace);
  return outcome;
}

/**
 * Stores an account that was connected to `workspace` as a channel, with
 * the access to it, sealed. An account that has a channel already keeps
 * it. Clients that are connected receive the channel at once.
 *
 * `call.key` names the call, as for `mutateWorkspace`: it is carried out
 * once, and a caller that cannot tell whether it arrived repeats it with
 * the same key and is answered as the first time. With `call.handBack`,
 * the answer has the access that the channel held before, sealed, if the
 * account had a channel already: this connection has replaced it, and the
 * workspace keeps it only for the repeats of this call, and for those only
 * for some minutes: `handBackLifetimeMs`. A repeat that comes later is
 * answered without it.
 */
export async function connectChannel(
  namespace: Bindings["WORKSPACE"],
  workspace: WorkspaceIdentity,
  channel: MutatorArgs<"channel.connect">,
  access: ChannelAccess,
  call: ConnectChannelCall = {},
): Promise<ConnectChannelOutcome> {
  const outcome = await namespace
    .getByName(workspace.id)
    .connectChannel(workspace, channel, access, call);
  if (!outcome) throw foreign(workspace);
  return outcome;
}

/**
 * Removes a channel of `workspace` and returns the access that it held,
 * sealed, or why it was not removed. The channel and its access go in one
 * step, so what is returned is all that pigy had of the account. Clients
 * that are connected hear of it at once.
 */
export async function disconnectChannel(
  namespace: Bindings["WORKSPACE"],
  workspace: WorkspaceIdentity,
  channelId: string,
): Promise<DisconnectChannelOutcome> {
  const outcome = await namespace
    .getByName(workspace.id)
    .disconnectChannel(workspace, channelId);
  if (!outcome) throw foreign(workspace);
  return outcome;
}

/**
 * What it takes to act for the account of a channel of `workspace`, sealed,
 * or null if the workspace has no such channel.
 */
export async function channelAccess(
  namespace: Bindings["WORKSPACE"],
  workspace: WorkspaceIdentity,
  channelId: string,
): Promise<StoredChannelAccess | null> {
  const access = await namespace
    .getByName(workspace.id)
    .channelAccess(workspace, channelId);
  if (access === undefined) throw foreign(workspace);
  return access;
}

/**
 * What the delivery `run` of `workspace` publishes and where it goes on
 * from, or null if it is not under way: it has ended, by a disconnect for
 * example, or is on a later attempt.
 */
export async function deliveryOf(
  namespace: Bindings["WORKSPACE"],
  workspace: WorkspaceIdentity,
  run: DeliveryRun,
): Promise<Delivery | null> {
  const delivery = await namespace
    .getByName(workspace.id)
    .delivery(workspace, run);
  if (delivery === undefined) throw foreign(workspace);
  return delivery;
}

/**
 * Tells `workspace` that the delivery `run` has passed its checks and is
 * about to make its first request to the network. From then on the other
 * deliveries to its channel that have published nothing begin anew when
 * they are tried again: what they recorded could lead them to a post of
 * this one. Returns whether the delivery is under way. It is safe to
 * repeat. Not to be called for a channel whose adapter tells the
 * deliveries to an account apart: see `aboutToSend` of the store.
 */
export async function aboutToSend(
  namespace: Bindings["WORKSPACE"],
  workspace: WorkspaceIdentity,
  run: DeliveryRun,
): Promise<boolean> {
  const underWay = await namespace
    .getByName(workspace.id)
    .aboutToSend(workspace, run);
  if (underWay === undefined) throw foreign(workspace);
  return underWay;
}

/**
 * Tells `workspace` that a step of the delivery `run` is about to be run,
 * for an adapter whose steps cannot be run again safely. `key` names the
 * step and `mark` this run of it. The answer has the mark of the run that
 * was noted first under the key: a run that is handed another than its
 * own must not send. It is refused with `not_current` if the delivery is
 * not under way any more. See `stepBegins` of the store.
 */
export async function stepBegins(
  namespace: Bindings["WORKSPACE"],
  workspace: WorkspaceIdentity,
  run: DeliveryRun,
  mark: string,
  key: string,
): Promise<StepBegun> {
  const begun = await namespace
    .getByName(workspace.id)
    .stepBegins(workspace, run, mark, key);
  if (!begun) throw foreign(workspace);
  return begun;
}

/**
 * Records how far the delivery `run` of `workspace` has come: `parts` is
 * every part that is published, in order, with the ID to give its result
 * if it has none, and `progress` what the adapter returned, for the next
 * attempt to go on from. Clients that are connected see the new parts at
 * once. It is refused with `not_current` if the delivery is not under way
 * any more. `key` names the call, as for `mutateWorkspace`: it is carried
 * out once.
 */
export async function recordProgress(
  namespace: Bindings["WORKSPACE"],
  workspace: WorkspaceIdentity,
  run: DeliveryRun,
  parts: MutatorArgs<"target.progress">["parts"],
  progress: unknown,
  key: string,
): Promise<MutationOutcome> {
  const outcome = await namespace
    .getByName(workspace.id)
    .recordProgress(workspace, run, parts, progress, key);
  if (!outcome) throw foreign(workspace);
  return outcome;
}

/**
 * Stores the credentials that a refresh has returned for a channel of
 * `workspace`, sealed, in place of the ones that it started from,
 * `expected`. Returns whether it did: not if the channel holds others by
 * now, which another refresh has put there, or is gone.
 */
export async function renewChannelAccess(
  namespace: Bindings["WORKSPACE"],
  workspace: WorkspaceIdentity,
  channelId: string,
  expected: string,
  access: RenewedChannelAccess,
): Promise<boolean> {
  const renewed = await namespace
    .getByName(workspace.id)
    .renewChannelAccess(workspace, channelId, expected, access);
  if (renewed === undefined) throw foreign(workspace);
  return renewed;
}

function foreign(workspace: WorkspaceIdentity): Error {
  return new Error(
    `The object of workspace ${workspace.id} holds another workspace`,
  );
}
