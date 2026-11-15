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
import type { MutationOutcome } from "./object.ts";
import type { WorkspaceIdentity } from "./store.ts";

/**
 * The Worker's side of workspaces: which there are, whose they are, and the
 * only ways into their Durable Objects.
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
 */
export async function mutateWorkspace<Name extends MutatorName>(
  namespace: Bindings["WORKSPACE"],
  workspace: WorkspaceIdentity,
  name: Name,
  args: MutatorArgs<Name>,
): Promise<MutationOutcome> {
  const outcome = await namespace
    .getByName(workspace.id)
    .mutate(workspace, name, args);
  if (!outcome) {
    throw new Error(
      `The object of workspace ${workspace.id} holds another workspace`,
    );
  }
  return outcome;
}
