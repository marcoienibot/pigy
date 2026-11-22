import { publicUrl } from "@pigy/providers";
import { and, eq, gt, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { pushSubscriptions, sessions } from "../db/schema.ts";
import { fromBase64Url, type PushTarget } from "./web-push.ts";

/**
 * The devices that get push messages, in the table `push_subscription` of
 * D1: what a browser handed out when somebody turned notifications on.
 */

/**
 * `endpoint` if pigy may send a request to it, or null. A browser names
 * the address of its push service, and what a browser says is the word of
 * whoever runs it: the Worker would send a request wherever it says. So
 * it has to be what `publicUrl` of @pigy/providers lets through for every
 * host that somebody else names: HTTPS, at a public host, with no port, no
 * credentials and no fragment. No IP address and no name of a private
 * network passes.
 */
export function pushEndpoint(endpoint: string): string | null {
  return publicUrl(endpoint);
}

/**
 * Whether `keys` are what a browser hands out with a subscription: a
 * point of P-256 of 65 bytes and a secret of 16, both in base64url.
 */
export function arePushKeys(keys: { p256dh: string; auth: string }): boolean {
  return (
    fromBase64Url(keys.p256dh)?.byteLength === 65 &&
    fromBase64Url(keys.auth)?.byteLength === 16
  );
}

/** A device, with what a message to it is signed as. */
export type Subscribed = PushTarget & {
  id: string;
  /** The address that pigy was reached at when the device subscribed. */
  origin: string;
};

/**
 * Takes the subscription of a browser for `session`, in place of whatever
 * was kept under its endpoint: a browser has one subscription, and it is
 * of whoever turned notifications on in it last.
 */
export async function subscribe(
  db: DrizzleD1Database,
  session: { userId: string; sessionId: string },
  target: PushTarget,
  made: { vapidKey: string; origin: string; at: Date },
): Promise<void> {
  const values = {
    userId: session.userId,
    sessionId: session.sessionId,
    p256dh: target.p256dh,
    auth: target.auth,
    vapidKey: made.vapidKey,
    origin: made.origin,
    createdAt: made.at,
  };
  await db
    .insert(pushSubscriptions)
    .values({ id: crypto.randomUUID(), endpoint: target.endpoint, ...values })
    .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: values });
}

/**
 * Whether the browser with this endpoint gets the push messages of
 * `session`, as a sender with the public key `vapidKey`.
 */
export async function isSubscribed(
  db: DrizzleD1Database,
  session: { userId: string; sessionId: string },
  endpoint: string,
  vapidKey: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.endpoint, endpoint),
        eq(pushSubscriptions.userId, session.userId),
        eq(pushSubscriptions.sessionId, session.sessionId),
        eq(pushSubscriptions.vapidKey, vapidKey),
      ),
    );
  return row !== undefined;
}

/** Forgets the subscription of `userId` with this endpoint, if there is one. */
export async function unsubscribe(
  db: DrizzleD1Database,
  userId: string,
  endpoint: string,
): Promise<void> {
  await db
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.endpoint, endpoint),
        eq(pushSubscriptions.userId, userId),
      ),
    );
}

/**
 * The devices of `userId` that a message can go to now, as a sender with
 * the public key `vapidKey`: those whose session is still good at `now`.
 * What was subscribed with another key is deleted here: no push service
 * takes a message for it from this one, and the device has to turn its
 * notifications on again.
 */
export async function devicesOf(
  db: DrizzleD1Database,
  userId: string,
  vapidKey: string,
  now: Date,
): Promise<Subscribed[]> {
  const rows = await db
    .select({
      id: pushSubscriptions.id,
      endpoint: pushSubscriptions.endpoint,
      p256dh: pushSubscriptions.p256dh,
      auth: pushSubscriptions.auth,
      origin: pushSubscriptions.origin,
      vapidKey: pushSubscriptions.vapidKey,
    })
    .from(pushSubscriptions)
    .innerJoin(sessions, eq(sessions.id, pushSubscriptions.sessionId))
    .where(
      and(eq(pushSubscriptions.userId, userId), gt(sessions.expiresAt, now)),
    );
  const stale = rows.filter((row) => row.vapidKey !== vapidKey);
  await forget(
    db,
    stale.map(({ id }) => id),
  );
  return rows
    .filter((row) => row.vapidKey === vapidKey)
    .map(({ vapidKey: _, ...device }) => device);
}

/** Deletes the subscriptions with these IDs. */
export async function forget(
  db: DrizzleD1Database,
  ids: string[],
): Promise<void> {
  // A statement of D1 takes a hundred values.
  for (let from = 0; from < ids.length; from += 50) {
    await db
      .delete(pushSubscriptions)
      .where(inArray(pushSubscriptions.id, ids.slice(from, from + 50)));
  }
}
