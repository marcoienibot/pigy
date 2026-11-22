import { uploadRequestsPerMinute } from "@pigy/core";
import { sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { uploadUses } from "../db/schema.ts";

const minuteMs = 60_000;

/**
 * Counts `weight` requests of an upload for the person `userId`, and says
 * whether they are within what a person may make in a minute,
 * `uploadRequestsPerMinute`: all their uploads together, in the app and
 * through the public API. One statement, so that two requests at once
 * are both counted.
 *
 * A request of the app carries a chunk of 5 MiB at most, and is one. A
 * request of the public API carries a whole file, and counts as many as
 * the app would make for it, so that a person takes in as many bytes in
 * a minute whichever way they upload.
 */
export async function countUploads(
  db: DrizzleD1Database,
  userId: string,
  now: Date,
  weight = 1,
): Promise<boolean> {
  const minute = Math.floor(now.getTime() / minuteMs) * minuteMs;
  const [use] = await db
    .insert(uploadUses)
    .values({ userId, windowStart: minute, count: weight })
    .onConflictDoUpdate({
      target: uploadUses.userId,
      set: {
        // Both from the row as it was: the count goes on within the
        // minute, and begins anew with the next.
        count: sql`case when ${uploadUses.windowStart} = excluded.window_start then ${uploadUses.count} + excluded.count else excluded.count end`,
        windowStart: sql`excluded.window_start`,
      },
    })
    .returning({ count: uploadUses.count });
  return (use?.count ?? 0) <= uploadRequestsPerMinute;
}
