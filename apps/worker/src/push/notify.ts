import type { Clock, Fetch, PushMessage } from "@pigy/core";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { log } from "../log.ts";
import {
  devicesOf,
  forget,
  pushEndpoint,
  type Subscribed,
} from "./subscriptions.ts";
import { sendPush, type VapidKey } from "./web-push.ts";

/**
 * For how long a push service keeps a message for a device that it cannot
 * reach, in seconds: a day. What it tells of is in the inbox of the app
 * for longer, so a device that was off for days is told there.
 */
export const pushTtlSeconds = 24 * 60 * 60;

/**
 * Who a push service is told sends, for a device that subscribed where
 * pigy was reached at `origin`: that address, which is where whoever runs
 * this pigy is found. RFC 8292 has an HTTPS address or a `mailto:` there.
 * A pigy that is reached without HTTPS is one on somebody's machine, and
 * has neither: it says so.
 */
export function pushSubject(origin: string): string {
  const url = new URL(origin);
  return url.protocol === "https:" ? url.origin : `mailto:pigy@${url.hostname}`;
}

/**
 * How many push services are asked at the same time for one message. A
 * person has `maxDevices` at most, so this is about not opening them all
 * at once, on a platform that allows a request few connections.
 */
export const pushesAtOnce = 4;

/** The message of `error`, without anything of the subscription `device`. */
function withoutSubscription(error: unknown, device: Subscribed): string {
  if (!(error instanceof Error)) return "unknown error";
  const { pathname, search } = new URL(device.endpoint);
  let message = error.message;
  for (const secret of [
    device.endpoint,
    pathname + search,
    device.p256dh,
    device.auth,
  ]) {
    // A path of "/" is no secret, and taking it out would take every
    // slash of the message.
    if (secret.length > 8) message = message.replaceAll(secret, "[…]");
  }
  return message;
}

/**
 * Sends `message` to every device that `userId` has turned notifications
 * on for, `pushesAtOnce` at a time, and returns how many took it. A device
 * whose push service says that its subscription is gone is forgotten.
 *
 * What goes wrong with one device is logged and does not keep the message
 * from the others. Nothing of a subscription is logged, its address
 * included: only the host of its push service. It throws only if the
 * devices could not be read: then nothing was sent, and the caller tries
 * again. Once a device was tried, it does not throw: a caller that tried
 * again would send to the devices that have the message a second time.
 * So a subscription that is gone and could not be deleted is logged, and
 * found gone again with the next message.
 */
export async function pushToDevices(
  {
    db,
    fetch,
    now,
    key,
  }: { db: DrizzleD1Database; fetch: Fetch; now: Clock; key: VapidKey },
  userId: string,
  message: PushMessage,
  topic: string,
): Promise<number> {
  const devices = await devicesOf(db, userId, key.publicKey, now());
  const body = new TextEncoder().encode(JSON.stringify(message));
  const gone: string[] = [];
  let sent = 0;
  const send = async (device: Subscribed): Promise<void> => {
    // Checked when the subscription was taken, and again here: what is
    // in the database is not trusted more than what a browser said.
    if (pushEndpoint(device.endpoint, hostOf(device.origin)) === null) {
      gone.push(device.id);
      return;
    }
    const { host } = new URL(device.endpoint);
    try {
      const outcome = await sendPush({ fetch, now }, key, device, body, {
        ttlSeconds: pushTtlSeconds,
        topic,
        subject: pushSubject(device.origin),
      });
      if (outcome.outcome === "sent") sent += 1;
      else if (outcome.outcome === "gone") gone.push(device.id);
      else if (outcome.outcome === "refused") {
        log.error("push", "A push service did not take a message", {
          host,
          status: outcome.status,
        });
      } else {
        log.error("push", "A push service did not answer", { host });
      }
    } catch (error) {
      // A failure of pigy's own, or of whatever stands behind `fetch`.
      // Its message is logged and nothing else of it, and that without
      // what it may repeat of the subscription: an error can name the
      // address that a request was for.
      log.error(
        "push",
        `A push message failed: ${withoutSubscription(error, device)}`,
        { host },
      );
    }
  };
  // Each of these takes the next device when it is done with one.
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(pushesAtOnce, devices.length) }, async () => {
      for (;;) {
        const device = devices[next];
        next += 1;
        if (!device) return;
        await send(device);
      }
    }),
  );
  try {
    await forget(db, gone);
  } catch (error) {
    log.error(
      "push",
      "The push subscriptions that are gone were not deleted",
      {},
      error,
    );
  }
  return sent;
}

/** The host of the address `origin`, or none if it is no address. */
function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return "";
  }
}
