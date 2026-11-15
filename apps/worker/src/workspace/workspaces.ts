import { environments, type Workspace } from "@pigy/core";
import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { workspaces } from "../db/schema.ts";

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
