import type { Network } from "@pigy/core";
import type { Json } from "@pigy/providers";
import { and, eq, lte } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { oauthStates } from "../db/schema.ts";
import type { Vault } from "../vault.ts";

/**
 * The connections that have begun: what an adapter needs to finish one,
 * kept in the table `oauth_state` of D1 while the person is at the network.
 */

/**
 * How long somebody may take at a network before the connection has to be
 * started again.
 */
export const pendingLifetimeMs = 10 * 60 * 1000;

/** A connection that has begun. */
export type PendingConnection = {
  /** What the network will send back, and what the connection is kept under. */
  state: string;
  /** The session that began it, and the only one that can finish it. */
  sessionId: string;
  workspaceId: string;
  network: Network;
  /** What the adapter returned to finish with. It holds secrets. */
  pending: Json;
};

/**
 * What a sealed `pending` belongs to: the row it is stored in, with
 * everything the row says about whose connection it is. Somebody who can
 * write to the table and has no key can then not hand the connection of one
 * session, workspace or network to another: it no longer opens.
 */
const context = ({
  state,
  sessionId,
  workspaceId,
  network,
}: Omit<PendingConnection, "pending">) => [
  "oauth_state",
  state,
  sessionId,
  workspaceId,
  network,
];

/** Keeps a connection that has begun, for `pendingLifetimeMs`. */
export async function keepPending(
  db: DrizzleD1Database,
  vault: Vault,
  { pending, ...connection }: PendingConnection,
  now: Date,
): Promise<void> {
  await db.batch([
    // Nobody comes back for most of the connections that are given up, so
    // this is where they go.
    db.delete(oauthStates).where(lte(oauthStates.expiresAt, now)),
    db.insert(oauthStates).values({
      ...connection,
      pending: await vault.seal(context(connection), pending),
      expiresAt: new Date(now.getTime() + pendingLifetimeMs),
    }),
  ]);
}

/**
 * Takes out the connection that `sessionId` began and that the network
 * answers with `state`, if there is one that has not run out. It is gone
 * afterwards: an answer of a network is good once.
 *
 * The session is part of the question. A connection that another session
 * began is not found, and is left for that session to finish.
 */
export async function takePending(
  db: DrizzleD1Database,
  vault: Vault,
  state: string,
  sessionId: string,
  now: Date,
): Promise<PendingConnection | undefined> {
  const [taken] = await db
    .delete(oauthStates)
    .where(
      and(eq(oauthStates.state, state), eq(oauthStates.sessionId, sessionId)),
    )
    .returning();
  if (!taken || taken.expiresAt <= now) return undefined;
  return {
    ...taken,
    // Checked by the adapter, against its own schema.
    pending: (await vault.open(context(taken), taken.pending)) as Json,
  };
}
