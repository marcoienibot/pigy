import {
  listDurableObjectIds,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type PushMessage,
  pushConfigResponseSchema,
  pushMessageSchema,
} from "@pigy/core";
import type { SimulatedSubscription } from "@pigy/simulators/push";
import { expect, vi } from "vitest";
import { pushSubscriptions } from "../src/db/schema.ts";
import type { Browser, TestSetup } from "./helpers.ts";
import { patience } from "./publishing.ts";
import { objectOf } from "./sync-client.ts";

/**
 * What the tests of push messages share: the steps of a person who turns
 * notifications on, with a device that the simulated push service makes
 * up, and ways to look at what the devices got.
 */

/** The public key that the app hands a page to subscribe with. */
export async function publicKeyOf(browser: Browser): Promise<string> {
  const response = await browser.fetch("/api/push");
  expect(response.status).toBe(200);
  return pushConfigResponseSchema.parse(await response.json()).publicKey;
}

/**
 * Turns notifications on in a browser, as Settings do: the device
 * subscribes at its push service with the key of the app, and the app is
 * handed what the browser got. Returns the subscription.
 */
export async function turnOn(
  test: Pick<TestSetup, "push">,
  browser: Browser,
): Promise<SimulatedSubscription> {
  const subscription = await test.push.subscribe({
    applicationServerKey: await publicKeyOf(browser),
  });
  const response = await browser.fetch("/api/push/subscription", {
    method: "PUT",
    json: subscription,
  });
  expect(response.status).toBe(200);
  return subscription;
}

/** The messages that a device has received, as the app meant them. */
export function messagesOf(
  { push }: Pick<TestSetup, "push">,
  { endpoint }: SimulatedSubscription,
): PushMessage[] {
  return push.received(endpoint).map(({ payload, unreadable }) => {
    // A message that its device cannot read is one that nobody sees.
    expect(unreadable).toBeUndefined();
    return pushMessageSchema.parse(JSON.parse(payload ?? ""));
  });
}

/**
 * Waits until no workspace has a push message left to send, and until the
 * alarm that sent the last one is over. A test ends with this, through
 * `received` or `attend`: the next test begins by taking every object out
 * of memory, and an object that is taken away in the middle of its alarm
 * has the runtime try that alarm again, while the database is emptied.
 */
export async function idle(): Promise<void> {
  const ids = await listDurableObjectIds(env.WORKSPACE);
  await vi.waitFor(async () => {
    for (const id of ids) {
      const waiting = await runInDurableObject(
        env.WORKSPACE.get(id),
        (_, state) =>
          state.storage.sql
            .exec<{ count: number }>(
              "select count(*) as count from push_outbox",
            )
            .one().count,
      );
      expect(waiting).toBe(0);
    }
  }, patience);
  // What is left of an alarm once it has sent: it sets the next one.
  await new Promise((resolve) => setTimeout(resolve, 50));
}

/** Waits until a device has received `count` messages, and returns them. */
export async function received(
  test: Pick<TestSetup, "push">,
  subscription: SimulatedSubscription,
  count: number,
): Promise<PushMessage[]> {
  await vi.waitFor(
    () => expect(messagesOf(test, subscription)).toHaveLength(count),
    patience,
  );
  await idle();
  return messagesOf(test, subscription);
}

/** The push messages of a workspace that wait to be sent. */
export function queuedIn(workspaceId: string): Promise<number> {
  return runInDurableObject(
    objectOf(workspaceId),
    (_, state) =>
      state.storage.sql
        .exec<{ count: number }>("select count(*) as count from push_outbox")
        .one().count,
  );
}

/**
 * Has the object of a workspace do what it does by the clock, now, and
 * waits until it has nothing left to send.
 */
export async function attend(workspaceId: string): Promise<void> {
  await runDurableObjectAlarm(objectOf(workspaceId));
  await idle();
}

/** The endpoints that the app keeps, of everybody. */
export async function keptEndpoints({
  db,
}: Pick<TestSetup, "db">): Promise<string[]> {
  const rows = await db
    .select({ endpoint: pushSubscriptions.endpoint })
    .from(pushSubscriptions);
  return rows.map(({ endpoint }) => endpoint).sort();
}
