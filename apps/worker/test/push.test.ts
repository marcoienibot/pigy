import { runInDurableObject } from "cloudflare:test";
import { pushHosts } from "@pigy/simulators/push";
import type { SimToken } from "@pigy/simulators/world";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { pushesAtOnce } from "../src/push/notify.ts";
import { maxDevices, pushEndpoint } from "../src/push/subscriptions.ts";
import { pushesPerPass } from "../src/workspace/object.ts";
import { WorkspaceStore } from "../src/workspace/store.ts";
import {
  connectInSandbox,
  connectLinkedInLive,
  connectThreadsLive,
} from "./channels.ts";
import {
  adminEmail,
  breakDatabase,
  expectErrors,
  expectWarnings,
  invite,
  logged,
  signedIn,
  signInThroughPages,
  vapidPrivateKey,
} from "./helpers.ts";
import {
  connectAccount,
  ended,
  follow,
  patience,
  publishTo,
  retry,
  started,
  targetOf,
  writeDraft,
} from "./publishing.ts";
import {
  attend,
  idle,
  keptEndpoints,
  messagesOf,
  publicKeyOf,
  queuedIn,
  received,
  turnOn,
} from "./push.ts";
import { objectOf, SyncClient, workspaceIds } from "./sync-client.ts";

/** A push message about a post of `workspaceId`, as the object queues one. */
const pushMessage = (workspaceId: string, postId: string) =>
  JSON.stringify({
    v: 1,
    kind: "post_failed",
    workspaceId,
    environment: "live",
    postId,
  });

const day = 24 * 60 * 60 * 1000;

/**
 * Lets `days` pass for somebody who goes on using pigy: a session lasts 30
 * days from when it was last used, and a device whose session is over is
 * told nothing.
 */
async function pass(
  test: Awaited<ReturnType<typeof started>>["test"],
  browser: Awaited<ReturnType<typeof started>>["browser"],
  days: number,
): Promise<void> {
  for (let left = days; left > 0; left -= 20) {
    test.advance(Math.min(left, 20) * day);
    expect((await browser.fetch("/api/me")).status).toBe(200);
  }
}

/**
 * A client that follows `workspace` from now. A socket lasts five minutes,
 * so a test that has let time pass looks at the workspace with a new one.
 */
async function looking(
  browser: Awaited<ReturnType<typeof started>>["browser"],
  workspace: string,
): Promise<SyncClient> {
  const client = new SyncClient();
  await client.connect(browser, workspace);
  return client;
}

/** A text that no Mastodon account of the tests may post: it is too long. */
const tooLong = "a".repeat(600);

/**
 * `started()`, for a pigy that has a key to send push messages with.
 *
 * Such a pigy sends from the alarms of its workspaces, and a test can be
 * over before an alarm is. So every test waits at its end until nothing
 * is left to send: the next one begins by deleting every object, and an
 * object that is deleted in the middle of its alarm comes back with what
 * it had, when the runtime tries the alarm again.
 */
const withPush = (options: Parameters<typeof started>[0] = {}) => {
  onTestFinished(idle);
  return started({
    ...options,
    env: { VAPID_PRIVATE_KEY: vapidPrivateKey, ...options.env },
  });
};

/**
 * A signed-in admin with a Mastodon account connected to the live
 * workspace, and a client that follows that workspace.
 */
async function withChannel(options: Parameters<typeof started>[0] = {}) {
  const context = await withPush(options);
  const workspace = context.workspaces.live;
  const channel = await connectAccount(
    context.test,
    context.browser,
    workspace,
  );
  const client = new SyncClient();
  await client.connect(context.browser, workspace);
  return { ...context, workspace, channel, client };
}

type Context = Awaited<ReturnType<typeof withChannel>>;

/** Publishes `text` to the channel and follows the post to its end. */
async function published(
  { client, workspace, channel }: Context,
  text: string,
) {
  const draft = await writeDraft(client, workspace, text);
  const [targetId = ""] = await publishTo(client, draft.postId, channel);
  await ended(client, draft.postId);
  return { ...draft, targetId };
}

describe("a delivery that fails", () => {
  it("ends in one notification of the inbox and one message to each device", async () => {
    const context = await withChannel();
    const { test, browser, client, workspace } = context;
    const phone = await turnOn(test, browser);
    // The same person on a second device, with a session of its own.
    const laptop = await turnOn(
      test,
      await signedIn(test, { email: adminEmail }),
    );

    const { postId } = await published(context, tooLong);

    expect(client.table("notification")).toEqual([
      {
        id: postId,
        kind: "post_failed",
        postId,
        channelId: null,
        createdAt: expect.any(Number),
        readAt: null,
      },
    ]);
    const message = {
      v: 1,
      kind: "post_failed",
      workspaceId: workspace,
      environment: "live",
      postId,
    };
    expect(await received(test, phone, 1)).toEqual([message]);
    expect(await received(test, laptop, 1)).toEqual([message]);
    // Nothing is left to send, however often the object looks.
    await attend(workspace);
    expect(messagesOf(test, phone)).toHaveLength(1);
    expect(messagesOf(test, laptop)).toHaveLength(1);
  });

  it("sends a message as the standards have it", async () => {
    const context = await withChannel();
    const { test, browser } = context;
    const phone = await turnOn(test, browser);

    const { postId } = await published(context, tooLong);
    await received(test, phone, 1);

    // The simulated push service has checked the token of the sender and
    // decrypted the message, or nothing would have arrived. What is left
    // to say is what pigy chose.
    expect(test.push.received(phone.endpoint)).toMatchObject([
      {
        ttl: 24 * 60 * 60,
        urgency: "normal",
        // What a later message about the same post takes the place of.
        topic: postId.replaceAll("-", ""),
        sender: {
          aud: new URL(phone.endpoint).origin,
          // Where whoever runs this pigy is found.
          sub: "https://pigy.test",
          exp: test.clock.time.getTime() / 1000 + 12 * 60 * 60,
        },
      },
    ]);
  });

  it("says nothing that a lock screen should not show", async () => {
    const context = await withChannel();
    const { test, browser } = context;
    const phone = await turnOn(test, browser);

    await published(context, `${tooLong} secret plans`);
    await received(test, phone, 1);

    const [{ payload = "" } = {}] = test.push.received(phone.endpoint);
    // Neither the text of the post nor whose account it was for.
    expect(payload).not.toContain("secret plans");
    expect(payload).not.toContain("rosalind");
    expect(payload).not.toContain("Rosalind");
  });

  it("tells the devices again when another try fails too", async () => {
    const context = await withChannel();
    const { test, browser, client } = context;
    const phone = await turnOn(test, browser);
    const { postId, targetId } = await published(context, tooLong);
    await received(test, phone, 1);

    await retry(client, targetId);
    // While the post is on its way again, the inbox says nothing of it.
    expect(client.table("notification")).toEqual([]);
    await ended(client, postId);

    expect(client.table("notification")).toMatchObject([{ id: postId }]);
    expect(await received(test, phone, 2)).toMatchObject([
      { kind: "post_failed", postId },
      { kind: "post_failed", postId },
    ]);
  });

  it("is told as unknown where nobody knows how it ended", async () => {
    const { test, browser, workspaces } = await withPush();
    const workspace = workspaces.live;
    const { channel = "" } = await connectLinkedInLive(
      test,
      browser,
      workspace,
    );
    const client = new SyncClient();
    await client.connect(browser, workspace);
    const phone = await turnOn(test, browser);
    // LinkedIn takes the post and its answer is lost: pigy cannot look.
    test.network.linkedin.arm({ kind: "lost-response", operation: "publish" });

    const draft = await writeDraft(client, workspace, "Hello");
    await publishTo(client, draft.postId, channel);
    await ended(client, draft.postId);

    expect(client.table("post_target")).toMatchObject([
      { status: "uncertain" },
    ]);
    expect(await received(test, phone, 1)).toEqual([
      {
        v: 1,
        kind: "post_uncertain",
        workspaceId: workspace,
        environment: "live",
        postId: draft.postId,
      },
    ]);
  });

  it("is told with the name of the sandbox where it is of the sandbox", async () => {
    const { test, browser, workspaces } = await withPush();
    const workspace = workspaces.sandbox;
    const { channel = "" } = await connectInSandbox(browser, workspace);
    const client = new SyncClient();
    await client.connect(browser, workspace);
    const phone = await turnOn(test, browser);

    const draft = await writeDraft(client, workspace, tooLong);
    await publishTo(client, draft.postId, channel);
    await ended(client, draft.postId);

    expect(await received(test, phone, 1)).toEqual([
      {
        v: 1,
        kind: "post_failed",
        workspaceId: workspace,
        environment: "sandbox",
        postId: draft.postId,
      },
    ]);
  });
});

describe("a channel that needs connecting again", () => {
  it("ends in a notification and a message of its own, next to those of the post", async () => {
    const context = await withChannel();
    const { test, browser, client, workspace, channel } = context;
    const phone = await turnOn(test, browser);
    test.network.mastodon.arm({ kind: "token-revoked", operation: "publish" });

    const { postId } = await published(context, "Hello");

    expect(client.table("channel")).toMatchObject([
      { status: "needs_reconnect" },
    ]);
    expect(
      client
        .table("notification")
        .map(({ id, kind }) => [id, kind])
        .sort(),
    ).toEqual(
      [
        [channel, "channel_needs_reconnect"],
        [postId, "post_failed"],
      ].sort(),
    );
    const messages = await received(test, phone, 2);
    expect(messages).toContainEqual({
      v: 1,
      kind: "channel_needs_reconnect",
      workspaceId: workspace,
      environment: "live",
      channelId: channel,
      network: "mastodon",
    });
    expect(messages).toContainEqual(
      expect.objectContaining({ kind: "post_failed", postId }),
    );
  });

  it("leaves the inbox when the account is connected again", async () => {
    const context = await withChannel();
    const { test, browser, client, workspace } = context;
    test.network.mastodon.arm({ kind: "token-revoked", operation: "publish" });
    const { postId } = await published(context, "Hello");

    await connectAccount(test, browser, workspace);
    await follow(client, () => client.table("notification").length === 1);

    // What is left is the post, which still has not arrived.
    expect(client.table("notification")).toMatchObject([{ id: postId }]);
  });
});

describe("an access that pigy renews", () => {
  /** A Threads account connected to the live workspace, and a device. */
  async function withThreads() {
    const context = await withPush();
    const { test, browser } = context;
    const workspace = context.workspaces.live;
    const outcome = await connectThreadsLive(test, browser, workspace);
    expect(outcome.connect).toBe("connected");
    await Promise.all(test.keptAlive);
    const phone = await turnOn(test, browser);
    return { ...context, workspace, phone, channel: outcome.channel ?? "" };
  }

  it("is told of as one to connect again when its network will not renew it", async () => {
    const { test, browser, workspace, phone, channel } = await withThreads();
    expectWarnings();
    // The person has removed pigy in the settings of their account.
    for (const { token } of test.network.world.tokens<SimToken>("threads")) {
      test.network.world.revokeToken("threads", token);
    }

    // A week after the connection the timer asks Threads, which refuses.
    await pass(test, browser, 7);
    await attend(workspace);

    expect(
      (await looking(browser, workspace)).table("notification"),
    ).toMatchObject([{ id: channel, kind: "channel_needs_reconnect" }]);
    expect(await received(test, phone, 1)).toEqual([
      {
        v: 1,
        kind: "channel_needs_reconnect",
        workspaceId: workspace,
        environment: "live",
        channelId: channel,
        network: "threads",
      },
    ]);
  });

  it("is not reminded of while the renewals work, and is once they have not worked for weeks", async () => {
    const { test, browser, workspace, phone, channel } = await withThreads();

    // More than the 60 days of one access, renewed every week: its end is
    // never less than 53 days away.
    for (let week = 0; week < 10; week += 1) {
      await pass(test, browser, 7);
      await attend(workspace);
    }
    expect((await looking(browser, workspace)).table("notification")).toEqual(
      [],
    );
    expect(messagesOf(test, phone)).toEqual([]);

    // Nothing has renewed the access for 54 days, and Threads is in
    // trouble when the timer asks now: the end is six days away.
    expectWarnings();
    await pass(test, browser, 54);
    test.network.threads.arm({ kind: "server-error", operation: "refresh" });
    await attend(workspace);

    expect(
      (await looking(browser, workspace)).table("notification"),
    ).toMatchObject([{ id: channel, kind: "channel_expiring" }]);
    expect(await received(test, phone, 1)).toMatchObject([
      { kind: "channel_expiring", channelId: channel, network: "threads" },
    ]);
  });

  it("is reminded of again when the renewals stop working another time", async () => {
    const { test, browser, workspace, phone } = await withThreads();
    expectWarnings();
    await pass(test, browser, 54);
    test.network.threads.arm({ kind: "server-error", operation: "refresh" });
    await attend(workspace);
    await received(test, phone, 1);

    // An hour later Threads answers: the access has another end, and the
    // reminder of the old one goes.
    await pass(test, browser, 1);
    await attend(workspace);
    expect((await looking(browser, workspace)).table("notification")).toEqual(
      [],
    );

    // Months later the same happens to the end that the access has then.
    await pass(test, browser, 54);
    test.network.threads.arm({ kind: "server-error", operation: "refresh" });
    await attend(workspace);
    expect(await received(test, phone, 2)).toHaveLength(2);
  });
});

describe("an access that ends by its date", () => {
  /** A LinkedIn account connected to the live workspace: 60 days. */
  async function withLinkedIn() {
    const context = await withPush();
    const { test, browser } = context;
    const workspace = context.workspaces.live;
    const { channel = "" } = await connectLinkedInLive(
      test,
      browser,
      workspace,
    );
    return { ...context, workspace, channel };
  }

  it("is told of a week before, once", async () => {
    const { test, browser, workspace, channel } = await withLinkedIn();
    const phone = await turnOn(test, browser);

    // The day before the week begins, the object has nothing to say.
    await pass(test, browser, 52);
    await attend(workspace);
    expect((await looking(browser, workspace)).table("notification")).toEqual(
      [],
    );
    expect(messagesOf(test, phone)).toEqual([]);

    await pass(test, browser, 1);
    await attend(workspace);

    const client = await looking(browser, workspace);
    expect(client.table("notification")).toEqual([
      {
        id: channel,
        kind: "channel_expiring",
        postId: null,
        channelId: channel,
        createdAt: expect.any(Number),
        readAt: null,
      },
    ]);
    expect(await received(test, phone, 1)).toEqual([
      {
        v: 1,
        kind: "channel_expiring",
        workspaceId: workspace,
        environment: "live",
        channelId: channel,
        network: "linkedin",
        // For the device to say how far the end is when it shows this.
        expiresAt: (await looking(browser, workspace)).table("channel")[0]
          ?.expiresAt,
      },
    ]);

    // Dismissed, it does not come back, however often the object looks:
    // an access is told of once.
    const [shown] = client.table("notification");
    client.mutate("notification.dismiss", {
      id: channel,
      createdAt: shown?.createdAt ?? 0,
    });
    await client.patch();
    await pass(test, browser, 1);
    await attend(workspace);
    expect((await looking(browser, workspace)).table("notification")).toEqual(
      [],
    );
    expect(messagesOf(test, phone)).toHaveLength(1);
  });

  it("is told of again for the access of a new connection", async () => {
    const { test, browser, workspace, channel } = await withLinkedIn();
    const phone = await turnOn(test, browser);
    await pass(test, browser, 53);
    await attend(workspace);
    await received(test, phone, 1);

    // Connecting again is what the reminder asked for: it goes.
    await connectLinkedInLive(test, browser, workspace);
    expect((await looking(browser, workspace)).table("notification")).toEqual(
      [],
    );

    // And 53 days later the new access is a week from its end.
    await pass(test, browser, 53);
    await attend(workspace);
    expect(
      (await looking(browser, workspace)).table("notification"),
    ).toMatchObject([{ id: channel, kind: "channel_expiring" }]);
    expect(await received(test, phone, 2)).toHaveLength(2);
  });

  it("is not told of once it is over", async () => {
    const { test, browser, workspace } = await withLinkedIn();
    const phone = await turnOn(test, browser);

    // The object slept through the whole week: the screen of the channel
    // says that the access has ended, and a reminder would be late.
    await pass(test, browser, 61);
    await attend(workspace);
    await attend(workspace);

    expect((await looking(browser, workspace)).table("notification")).toEqual(
      [],
    );
    expect(messagesOf(test, phone)).toEqual([]);
  });

  it("is not told to a device whose session has run out", async () => {
    const { test, browser, workspace, channel } = await withLinkedIn();
    const phone = await turnOn(test, browser);

    // Nobody has used pigy on the device for 53 days, and a session
    // lasts 30: the device is signed out, though nobody said so.
    test.advance(53 * day);
    await attend(workspace);

    expect(messagesOf(test, phone)).toEqual([]);
    expect(test.push.requests).toEqual([]);
    // The inbox has it for whoever signs in again.
    const again = await signedIn(test, { email: adminEmail });
    expect(
      (await looking(again, workspace)).table("notification"),
    ).toMatchObject([{ id: channel, kind: "channel_expiring" }]);
  });
});

it("removes a notification from the inbox after 30 days", async () => {
  const context = await withChannel();
  const { test, browser, workspace } = context;
  const { postId } = await published(context, tooLong);

  await pass(test, browser, 29);
  await attend(workspace);
  expect(
    (await looking(browser, workspace)).table("notification"),
  ).toHaveLength(1);

  await pass(test, browser, 1);
  // A mutation is run a little later than the clock says, when others
  // were run in the same millisecond.
  test.advance(1000);
  await attend(workspace);

  const client = await looking(browser, workspace);
  expect(client.table("notification")).toEqual([]);
  // The post itself stays where it was.
  expect(client.table("post")).toMatchObject([{ id: postId, status: "error" }]);
});

describe("the devices that are told", () => {
  it("forgets a device whose push service says that it is gone, and goes on telling the others", async () => {
    const context = await withChannel();
    const { test, browser } = context;
    const gone = await turnOn(test, browser);
    const there = await turnOn(
      test,
      await signedIn(test, { email: adminEmail }),
    );
    // The browser has unsubscribed, or was uninstalled: the push service
    // answers 410 from now on.
    test.push.unsubscribe(gone.endpoint);

    await published(context, tooLong);
    await received(test, there, 1);

    expect(await keptEndpoints(test)).toEqual([there.endpoint]);
    // The next message is not even tried there.
    test.push.requests.length = 0;
    await published(context, tooLong);
    await received(test, there, 2);
    expect(test.push.requests.map(({ url }) => url)).toEqual([there.endpoint]);
  });

  it("keeps a device whose push service is in trouble", async () => {
    const context = await withChannel();
    const { test, browser, workspace } = context;
    const errors = expectErrors();
    const phone = await turnOn(test, browser);
    test.push.arm("server-error");

    await published(context, tooLong);
    await attend(workspace);

    // That message is lost, and said so in the log: the inbox has what it
    // told of. The next one arrives.
    expect(messagesOf(test, phone)).toEqual([]);
    expect(errors).toHaveBeenCalledWith(
      "The push service at fcm.googleapis.com did not take a message: it answered 500",
    );
    expect(await keptEndpoints(test)).toEqual([phone.endpoint]);
    await published(context, tooLong);
    expect(await received(test, phone, 1)).toHaveLength(1);
  });

  it("tells nobody who is signed out", async () => {
    const context = await withChannel();
    const { test, browser, workspace } = context;
    const other = await signedIn(test, { email: adminEmail });
    const phone = await turnOn(test, other);

    // The session ends, and what the device had with it.
    expect(
      (await other.fetch("/api/auth/sign-out", { method: "POST" })).status,
    ).toBe(204);
    expect(await keptEndpoints(test)).toEqual([]);

    await published(context, tooLong);
    await attend(workspace);
    expect(messagesOf(test, phone)).toEqual([]);
    expect(test.push.requests).toEqual([]);
    // The browser that is still signed in is not a device that was
    // turned on: it is told in its inbox, like everybody.
    expect(browser.cookies.size).toBeGreaterThan(0);
  });

  it("tells the owner of a workspace and nobody else", async () => {
    const context = await withChannel();
    const { test, workspace } = context;
    await invite(test, "grace@example.com");
    const grace = await signedIn(test, { email: "grace@example.com" });
    const hers = await turnOn(test, grace);

    await published(context, tooLong);
    await attend(workspace);

    expect(messagesOf(test, hers)).toEqual([]);
  });

  it("does not hand the device of somebody who is signed in to another person who names its address", async () => {
    const context = await withChannel();
    const { test, browser } = context;
    const phone = await turnOn(test, browser);
    await invite(test, "grace@example.com");
    const grace = await signedIn(test, { email: "grace@example.com" });

    // Grace has learned the subscription of the admin's device, or signed
    // in on the same browser over a session that is still good.
    const response = await grace.fetch("/api/push/subscription", {
      method: "PUT",
      json: phone,
    });

    expect(response.status).toBe(409);
    // The device is still the admin's, and is told of the admin's post.
    await published(context, tooLong);
    expect(await received(test, phone, 1)).toHaveLength(1);
    expect(await keptEndpoints(test)).toEqual([phone.endpoint]);
  });

  it("hands a device to the next person once the session that turned it on is over", async () => {
    const context = await withChannel();
    const { test, browser, workspace } = context;
    const phone = await turnOn(test, browser);
    // Nobody has used the admin's session for longer than it lasts. Its
    // row is still there: nothing has deleted it.
    test.advance(31 * day);
    await invite(test, "grace@example.com");
    const grace = await signedIn(test, { email: "grace@example.com" });

    // The same browser hands out the subscription that it has.
    const response = await grace.fetch("/api/push/subscription", {
      method: "PUT",
      json: phone,
    });
    expect(response.status).toBe(200);

    const again = await signedIn(test, { email: adminEmail });
    const client = await looking(again, workspace);
    await published({ ...context, client }, tooLong);
    await attend(workspace);
    // What the admin's post did is not told to a device that is Grace's.
    expect(messagesOf(test, phone)).toEqual([]);
    expect(await keptEndpoints(test)).toEqual([phone.endpoint]);
  });

  it("hands a device to the same person who has signed in anew in its browser", async () => {
    const context = await withChannel();
    const { test, browser } = context;
    const phone = await turnOn(test, browser);
    const again = await signedIn(test, { email: adminEmail });

    const response = await again.fetch("/api/push/subscription", {
      method: "PUT",
      json: phone,
    });

    expect(response.status).toBe(200);
    expect(await keptEndpoints(test)).toEqual([phone.endpoint]);
    await published(context, tooLong);
    // One row, so one message.
    expect(await received(test, phone, 1)).toHaveLength(1);
  });

  it("keeps one subscription for a session, the one that its browser handed out last", async () => {
    const { test, browser } = await withPush();
    await turnOn(test, browser);

    // The browser has unsubscribed and subscribed anew, or somebody sends
    // one made-up subscription after the other.
    const second = await turnOn(test, browser);

    expect(await keptEndpoints(test)).toEqual([second.endpoint]);
  });

  it("keeps the ten devices that a person turned on last", async () => {
    const { test, browser } = await withPush();
    const devices = [await turnOn(test, browser)];
    for (let more = 0; more < maxDevices; more += 1) {
      // Each in a browser of its own, a moment after the one before.
      test.advance(1000);
      devices.push(
        await turnOn(test, await signedIn(test, { email: adminEmail })),
      );
    }

    // Eleven were turned on: the first of them is gone.
    expect(await keptEndpoints(test)).toEqual(
      devices
        .slice(1)
        .map(({ endpoint }) => endpoint)
        .sort(),
    );
  });

  it("asks only so many push services at once", async () => {
    let open = 0;
    let most = 0;
    const context = await withChannel({
      interceptPush: (push) => async (input, init) => {
        open += 1;
        most = Math.max(most, open);
        try {
          // Long enough for every request that is made at once to be
          // open at the same time.
          await new Promise((resolve) => setTimeout(resolve, 20));
          return await push(input, init);
        } finally {
          open -= 1;
        }
      },
    });
    const { test, browser } = context;
    const devices = [await turnOn(test, browser)];
    while (devices.length < maxDevices) {
      devices.push(
        await turnOn(test, await signedIn(test, { email: adminEmail })),
      );
    }

    await published(context, tooLong);

    for (const device of devices) await received(test, device, 1);
    expect(most).toBe(pushesAtOnce);
  });

  it("does not send a message again to the devices that have it when a device that is gone could not be forgotten", async () => {
    const context = await withChannel();
    const { test, browser, workspace } = context;
    const gone = await turnOn(test, browser);
    const there = await turnOn(
      test,
      await signedIn(test, { email: adminEmail }),
    );
    test.push.unsubscribe(gone.endpoint);
    const errors = expectErrors();
    // The database is in trouble when the subscription that is gone is
    // deleted, after the other device has taken its message.
    const mend = breakDatabase((sql) =>
      sql.startsWith('delete from "push_subscription"'),
    );

    await published(context, tooLong);
    // Which waits until nothing is left to send: the message is off the
    // queue although the cleaning up failed.
    await received(test, there, 1);
    await attend(workspace);

    expect(messagesOf(test, there)).toHaveLength(1);
    expect(errors).toHaveBeenCalledWith(
      "The push subscriptions that are gone were not deleted",
      expect.anything(),
    );
    // The device that is gone is found gone again with the next message.
    mend();
    await published(context, tooLong);
    await received(test, there, 2);
    expect(await keptEndpoints(test)).toEqual([there.endpoint]);
  });

  it("turns a device off, and only for the person whose it is", async () => {
    const context = await withChannel();
    const { test, browser } = context;
    const phone = await turnOn(test, browser);
    const state = async (as = browser) => {
      const response = await as.fetch("/api/push/subscription/state", {
        method: "POST",
        json: { endpoint: phone.endpoint },
      });
      return (await response.json()) as unknown;
    };
    expect(await state()).toEqual({ subscribed: true });
    await invite(test, "grace@example.com");
    const grace = await signedIn(test, { email: "grace@example.com" });
    // The device is not hers, whatever she knows of its address.
    expect(await state(grace)).toEqual({ subscribed: false });
    await grace.fetch("/api/push/subscription", {
      method: "DELETE",
      json: { endpoint: phone.endpoint },
    });
    expect(await state()).toEqual({ subscribed: true });

    const response = await browser.fetch("/api/push/subscription", {
      method: "DELETE",
      json: { endpoint: phone.endpoint },
    });

    expect(response.status).toBe(200);
    expect(await state()).toEqual({ subscribed: false });
    await published(context, tooLong);
    await attend(context.workspace);
    expect(messagesOf(test, phone)).toEqual([]);
  });

  it("says that a device is off in a session that did not turn it on", async () => {
    const { test, browser } = await withPush();
    const phone = await turnOn(test, browser);

    // The same person, signed in anew: Settings say what holds for the
    // session at hand, which has turned nothing on.
    const again = await signedIn(test, { email: adminEmail });
    const response = await again.fetch("/api/push/subscription/state", {
      method: "POST",
      json: { endpoint: phone.endpoint },
    });

    expect(await response.json()).toEqual({ subscribed: false });
  });
});

describe("a push service that does not answer", () => {
  it("does not keep a post that is published meanwhile from going out", async () => {
    // A push service that takes a request and says nothing, until the
    // test lets it. `over` says that the app has its answer, or has given
    // the request up, which it does after ten seconds.
    const service = { hangs: false, asked: 0, over: 0 };
    const context = await withChannel({
      interceptPush: (push) => async (input, init) => {
        service.asked += 1;
        try {
          // Each side looks on a timer of its own: see `gate`.
          while (service.hangs) {
            if (init?.signal?.aborted) throw new TypeError("Given up");
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          return await push(input, init);
        } finally {
          service.over += 1;
        }
      },
    });
    onTestFinished(() => {
      service.hangs = false;
    });
    const { test, browser, client, workspace, channel } = context;
    const phone = await turnOn(test, browser);
    service.hangs = true;
    // A post fails, and the alarm of the workspace is telling the device.
    await published(context, tooLong);
    await vi.waitFor(() => expect(service.asked).toBe(1), patience);

    const { postId } = await writeDraft(client, workspace, "Hello");
    const [targetId = ""] = await publishTo(client, postId, channel);
    await ended(client, postId);

    // It went out while the push service was still being waited for: the
    // alarm that sent the message did not make the delivery wait for it.
    expect(targetOf(client, targetId)).toMatchObject({ status: "sent" });
    expect(service.over).toBe(0);

    // And the message arrives when the push service answers at last.
    service.hangs = false;
    expect(await received(test, phone, 1)).toMatchObject([
      { kind: "post_failed" },
    ]);
  });

  it("sends the queue in passes, with a look at the deliveries in between", async () => {
    const context = await withChannel();
    const { test, browser, workspace } = context;
    const phone = await turnOn(test, browser);
    const alarms = vi.spyOn(WorkspaceStore.prototype, "startDeliveries");
    onTestFinished(() => alarms.mockRestore());
    // More messages than one pass sends, queued while nothing is sent.
    const more = pushesPerPass + 3;
    await runInDurableObject(objectOf(workspace), async (_, state) => {
      // The alarm that the mutation which queues a message sets.
      await state.storage.setAlarm(Date.now() + 60_000);
      for (let index = 0; index < more; index += 1) {
        // Each about a post of its own: a push service keeps one message
        // of a topic for a device.
        const postId = `01932c07-0000-7000-8000-${String(index).padStart(12, "0")}`;
        state.storage.sql.exec(
          "insert into push_outbox (message, notification_id, queued_at) values (?, ?, ?)",
          pushMessage(workspace, postId),
          postId,
          test.clock.time.getTime(),
        );
      }
    });
    const before = alarms.mock.calls.length;

    await attend(workspace);

    expect(await received(test, phone, more)).toHaveLength(more);
    // The first pass stopped at its limit and asked for the alarm, which
    // looked at the deliveries before it sent the rest.
    expect(alarms.mock.calls.length - before).toBeGreaterThanOrEqual(2);
  });
});

describe("the address of a push service", () => {
  it.each([
    ["without HTTPS", "http://fcm.googleapis.com/push/abc"],
    ["of this machine", "https://localhost/push/abc"],
    ["of a private network", "https://push.internal/abc"],
    ["that is an IP address", "https://10.0.0.7/push/abc"],
    ["that is an IPv6 address", "https://[::1]/push/abc"],
    ["with a port", "https://fcm.googleapis.com:8443/push/abc"],
    ["with credentials", "https://user:secret@fcm.googleapis.com/push/abc"],
    ["that is no address", "fcm.googleapis.com/push/abc"],
    ["at a host that is no push service", "https://push.example.com/abc"],
    ["at a host next to a push service", "https://www.googleapis.com/abc"],
    [
      "at a host that only ends like a push service",
      "https://evilpush.apple.com/abc",
    ],
    [
      "at a host that only begins like a push service",
      "https://fcm.googleapis.com.example.com/abc",
    ],
  ])("is refused %s, and nothing is sent to it", async (_what, endpoint) => {
    const context = await withChannel();
    const { test, browser, workspace } = context;
    const { keys } = await test.push.subscribe({
      applicationServerKey: await publicKeyOf(browser),
    });

    const response = await browser.fetch("/api/push/subscription", {
      method: "PUT",
      json: { endpoint, keys },
    });

    expect(response.status).toBe(400);
    // What Settings show the person: such an address is also what a
    // browser has whose push service is not in pigy's list, and it is
    // told what that means for it, not what is wrong with an address.
    expect(await response.json()).toMatchObject({
      field: "endpoint",
      message:
        "pigy cannot send notifications to this browser yet. The inbox has what they would say.",
    });
    expect(await keptEndpoints(test)).toEqual([]);
    await published(context, tooLong);
    await attend(workspace);
    // Not to a push service, and not to anything else.
    expect(test.push.requests).toEqual([]);
    expect(
      test.network.requests.filter((request) => request.includes("abc")),
    ).toEqual([]);
  });

  it.each(pushHosts)(
    "is taken at %s, the push service of a browser",
    async (host) => {
      const context = await withChannel();
      const { test, browser } = context;
      const subscription = await test.push.subscribe({
        applicationServerKey: await publicKeyOf(browser),
        host,
      });

      const response = await browser.fetch("/api/push/subscription", {
        method: "PUT",
        json: subscription,
      });

      expect(response.status).toBe(200);
      await published(context, tooLong);
      expect(await received(test, subscription, 1)).toHaveLength(1);
    },
  );

  it.each([
    "https://wns2-par02p.notify.windows.com/w/?token=abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://autopush.push.services.mozilla.com/wpush/v2/abc",
    "https://web.push.apple.com/abc",
    "https://fcm.googleapis.com/fcm/send/abc",
  ])("passes for %s", (endpoint) => {
    expect(pushEndpoint(endpoint, "pigy.example")).toBe(endpoint);
  });

  it("never passes for the host that pigy itself is reached at", () => {
    // A list of hosts can be wrong, or pigy can be run at a host under
    // one of them: the Worker does not send to itself all the same.
    const endpoint = "https://pigy.push.apple.com/api/admin/allowlist";
    expect(pushEndpoint(endpoint, "elsewhere.example")).toBe(endpoint);
    expect(pushEndpoint(endpoint, "pigy.push.apple.com")).toBeNull();
    expect(pushEndpoint(endpoint, "PIGY.push.apple.com")).toBeNull();
  });

  it("is not asked when it got into the database some other way", async () => {
    const context = await withChannel();
    const { test, browser, workspace } = context;
    const phone = await turnOn(test, browser);
    const { pushSubscriptions } = await import("../src/db/schema.ts");
    await test.db
      .update(pushSubscriptions)
      .set({ endpoint: "https://10.0.0.7/x" });

    await published(context, tooLong);
    await attend(workspace);

    expect(test.push.requests).toEqual([]);
    expect(
      test.network.requests.filter((request) => request.includes("10.0.0.7")),
    ).toEqual([]);
    // It is no subscription, and goes.
    expect(await keptEndpoints(test)).toEqual([]);
    expect(messagesOf(test, phone)).toEqual([]);
  });

  it("is refused with keys that no browser hands out", async () => {
    const { test, browser } = await withPush();
    const { endpoint } = await test.push.subscribe({
      applicationServerKey: await publicKeyOf(browser),
    });

    const response = await browser.fetch("/api/push/subscription", {
      method: "PUT",
      json: { endpoint, keys: { p256dh: "abc", auth: "abc" } },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ field: "keys" });
  });
});

describe("the secrets of a subscription", () => {
  it("are in no log when the database fails under them", async () => {
    const { test, browser } = await withPush();
    const errors = expectErrors();
    const subscription = await test.push.subscribe({
      applicationServerKey: await publicKeyOf(browser),
    });
    const values: unknown[] = [];
    // The statement that stores the subscription, which is the one that
    // is run with its keys.
    breakDatabase(
      (sql) => sql.startsWith('insert into "push_subscription"'),
      values,
    );

    const response = await browser.fetch("/api/push/subscription", {
      method: "PUT",
      json: subscription,
    });

    expect(response.status).toBe(500);
    // The statement was run with them, which is how they would get there.
    expect(values).toContain(subscription.keys.auth);
    const log = logged(errors.mock.calls);
    expect(log).toContain("push_subscription");
    expect(log).not.toContain(subscription.keys.auth);
    expect(log).not.toContain(subscription.keys.p256dh);
    expect(log).not.toContain(subscription.endpoint);
  });

  it("are in no log when a push service fails, or what stands behind it", async () => {
    let fail = false;
    const context = await withChannel({
      interceptPush: (push) => async (input, init) => {
        // No failure of a network: a bug in whatever `fetch` is.
        if (fail) throw new Error(`Cannot send ${String(input)}`);
        return push(input, init);
      },
    });
    const { test, browser, workspace } = context;
    const errors = expectErrors();
    const phone = await turnOn(test, browser);
    test.push.arm("rate-limit");
    await published(context, tooLong);
    await attend(workspace);
    fail = true;
    await published(context, tooLong);
    await attend(workspace);

    const log = logged(errors.mock.calls);
    // Both failures are there, by the host of the push service alone.
    expect(log).toContain("fcm.googleapis.com did not take a message");
    expect(log).toContain("A push message to fcm.googleapis.com failed");
    expect(log).not.toContain(new URL(phone.endpoint).pathname);
    expect(log).not.toContain(phone.keys.auth);
    expect(log).not.toContain(phone.keys.p256dh);
  });
});

describe("a pigy without a key to send with", () => {
  it("says that notifications are not set up, and still fills the inbox", async () => {
    const context = await withChannel({
      env: { VAPID_PRIVATE_KEY: undefined },
    });
    const { test, browser, client, workspace } = context;

    const config = await browser.fetch("/api/push");
    expect(config.status).toBe(503);
    expect(await config.json()).toMatchObject({
      message:
        "Whoever runs this pigy has not set it up to send notifications.",
    });
    const subscribed = await browser.fetch("/api/push/subscription", {
      method: "PUT",
      json: {
        endpoint: "https://fcm.googleapis.com/push/abc",
        keys: { p256dh: "abc", auth: "abc" },
      },
    });
    expect(subscribed.status).toBe(503);

    const { postId } = await published(context, tooLong);
    await attend(workspace);

    expect(client.table("notification")).toMatchObject([{ id: postId }]);
    // Nothing waits for a key that may never come.
    expect(await queuedIn(workspace)).toBe(0);
    expect(test.push.requests).toEqual([]);
  });

  it("does not take a key that is none", async () => {
    const { browser } = await withPush({
      env: { VAPID_PRIVATE_KEY: "not a key" },
    });
    const errors = expectErrors();

    expect((await browser.fetch("/api/push")).status).toBe(503);
    expect(errors).toHaveBeenCalledWith(
      "No push message can be sent: VAPID_PRIVATE_KEY is not a key of P-256 in PKCS #8 and base64.",
    );
  });

  it("drops the devices that subscribed with a key that it no longer has", async () => {
    const context = await withChannel();
    const { test, browser, workspace } = context;
    const phone = await turnOn(test, browser);
    const before = await publicKeyOf(browser);
    const { developmentVapidKey } = await import("../src/development-keys.ts");

    // Whoever runs this pigy has replaced the key.
    test.redeploy({ VAPID_PRIVATE_KEY: developmentVapidKey });

    expect(await publicKeyOf(browser)).not.toBe(before);
    // The device has to turn its notifications on again, and Settings say
    // that they are off.
    const state = await browser.fetch("/api/push/subscription/state", {
      method: "POST",
      json: { endpoint: phone.endpoint },
    });
    expect(await state.json()).toEqual({ subscribed: false });
    await published(context, tooLong);
    await attend(workspace);
    // No push service would take a message for it from the new key.
    expect(test.push.requests).toEqual([]);
    expect(await keptEndpoints(test)).toEqual([]);
  });
});

describe("a build for development", () => {
  const local = "http://localhost:5173";

  const setupDevelopment = () =>
    started({
      developmentCredentialKeys: true,
      env: { VAPID_PRIVATE_KEY: undefined },
    });

  it("has a key of its own where it is reached locally, and nowhere else", async () => {
    const { test, browser } = await setupDevelopment();

    // Deployed by mistake, it is a pigy without a key.
    expect((await browser.fetch("/api/push")).status).toBe(503);

    const development = await import("./helpers.ts").then(({ setup }) =>
      setup({
        simulatedGoogle: true,
        developmentCredentialKeys: true,
        env: {
          GOOGLE_CLIENT_ID: undefined,
          GOOGLE_CLIENT_SECRET: undefined,
          ADMIN_EMAILS: undefined,
          VAPID_PRIVATE_KEY: undefined,
        },
      }),
    );
    const atHome = development.browser(local);
    await signInThroughPages(atHome, adminEmail);
    const response = await atHome.fetch("/api/push");
    expect(response.status).toBe(200);
    // The other setup is the one that is deployed now: nothing of the
    // first is used below.
    expect(test).toBeDefined();
    expect(await workspaceIds(atHome)).toBeDefined();
  });
});

it("refuses a request to turn notifications on that comes from another site", async () => {
  const { test, browser } = await withPush();
  const subscription = await test.push.subscribe({
    applicationServerKey: await publicKeyOf(browser),
  });

  const response = await browser.fetch("/api/push/subscription", {
    method: "PUT",
    json: subscription,
    headers: { Origin: "https://elsewhere.example" },
  });

  expect(response.status).toBe(403);
  expect(await keptEndpoints(test)).toEqual([]);
});

it("refuses somebody who is not signed in", async () => {
  const { test } = await withPush();

  expect((await test.browser().fetch("/api/push")).status).toBe(401);
});
