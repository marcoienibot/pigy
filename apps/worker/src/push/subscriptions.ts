import { fromBase64Url } from "@pigy/core";
import { publicUrl } from "@pigy/providers";
import { and, desc, eq, gt, inArray, ne } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { pushSubscriptions, sessions } from "../db/schema.ts";
import { loggable } from "../errors.ts";
import type { PushTarget } from "./web-push.ts";

/**
 * The devices that get push messages, in the table `push_subscription` of
 * D1: what a browser handed out when somebody turned notifications on.
 */

/**
 * The hosts of the push services that pigy sends to: those of the
 * browsers that have Web Push. A subscription names the address of its
 * push service, and nobody but a browser should: an address at any other
 * host is one that somebody made up to have the Worker send requests
 * there. Each entry is a host, or with a leading dot every host under
 * one.
 *
 * The push service of a browser that is not here has to be added: its
 * users are told by Settings that pigy cannot send to their browser yet,
 * and the browser is not left subscribed.
 */
export const pushServiceHosts = [
  // Chrome, and what is built on Chromium without a service of its own:
  // Brave, Opera, Vivaldi, Samsung Internet.
  "fcm.googleapis.com",
  // Firefox.
  "updates.push.services.mozilla.com",
  ".push.services.mozilla.com",
  // Safari, on a Mac and from the Home Screen of an iPhone.
  ".push.apple.com",
  // Edge.
  ".notify.windows.com",
] as const;

/** Whether `host` is one of a push service: see `pushServiceHosts`. */
function isPushService(host: string): boolean {
  return pushServiceHosts.some((known) =>
    known.startsWith(".") ? host.endsWith(known) : host === known,
  );
}

/**
 * `endpoint` if pigy may send a request to it, or null. A browser names
 * the address of its push service, and what a browser says is the word of
 * whoever runs it: the Worker would send a request wherever it says. So
 * it has to be what `publicUrl` of @pigy/providers lets through for every
 * host that somebody else names: HTTPS, at a public host, with no port, no
 * credentials and no fragment. No IP address and no name of a private
 * network passes. And its host has to be one of a push service that pigy
 * knows, which is never `ownHost`, the host that pigy itself is reached
 * at: a list can be wrong, and a Worker that sends to itself is the
 * worst that it could be wrong about.
 */
export function pushEndpoint(endpoint: string, ownHost: string): string | null {
  const url = publicUrl(endpoint);
  if (url === null) return null;
  const { host } = new URL(url);
  return isPushService(host) && host !== ownHost.toLowerCase() ? url : null;
}

/**
 * How many devices a person has at most. Each is a request that the
 * Worker makes for every notification, so this bounds what one person can
 * have it send. Somebody who turns on an eleventh loses the one that was
 * turned on longest ago.
 */
export const maxDevices = 10;

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
 * Takes the subscription of a browser for `session`, and returns whether
 * it did.
 *
 * A session is one browser, and a browser has one subscription: whatever
 * else the session had goes. So does what the person has beyond
 * `maxDevices`, the oldest first.
 *
 * An endpoint that is kept already is the same browser, which hands out
 * the subscription that it has: the row is taken over when it is of the
 * same person, who has signed in anew. Not when it is of another person
 * whose session is still good: whoever knows the address of somebody's
 * subscription could otherwise take the device from them. That is
 * refused, and a browser in which another person has signed in since
 * subscribes anew, under another address.
 */
export async function subscribe(
  db: DrizzleD1Database,
  session: { userId: string; sessionId: string },
  target: PushTarget,
  made: { vapidKey: string; origin: string; at: Date },
): Promise<boolean> {
  const values = {
    userId: session.userId,
    sessionId: session.sessionId,
    p256dh: target.p256dh,
    auth: target.auth,
    vapidKey: made.vapidKey,
    origin: made.origin,
    createdAt: made.at,
  };
  // What is left of somebody else whose session is over: a device that
  // is told nothing, and that nobody is taken from.
  const [kept] = await db
    .select({
      id: pushSubscriptions.id,
      userId: pushSubscriptions.userId,
      sessionEndsAt: sessions.expiresAt,
    })
    .from(pushSubscriptions)
    .innerJoin(sessions, eq(sessions.id, pushSubscriptions.sessionId))
    .where(eq(pushSubscriptions.endpoint, target.endpoint));
  if (kept && kept.userId !== session.userId) {
    if (kept.sessionEndsAt > made.at) return false;
    await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, kept.id));
  }
  const taken = await db
    .insert(pushSubscriptions)
    .values({ id: crypto.randomUUID(), endpoint: target.endpoint, ...values })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: values,
      // Only a row of the same person: one that somebody else has put
      // there since the look above stays theirs.
      setWhere: eq(pushSubscriptions.userId, session.userId),
    })
    .returning({ id: pushSubscriptions.id });
  if (taken.length === 0) return false;
  await db
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.sessionId, session.sessionId),
        ne(pushSubscriptions.endpoint, target.endpoint),
      ),
    );
  const mine = await db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, session.userId))
    .orderBy(desc(pushSubscriptions.createdAt), desc(pushSubscriptions.id));
  await forget(
    db,
    mine.slice(maxDevices).map(({ id }) => id),
  );
  return true;
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
  // Tidying up, which must not keep a message from the devices that are
  // good: what is left is found again the next time.
  await forget(
    db,
    stale.map(({ id }) => id),
  ).catch((error: unknown) =>
    console.error(
      "The push subscriptions of another key were not deleted",
      loggable(error),
    ),
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
