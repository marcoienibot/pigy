import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { feed, type SimToken } from "@pigy/simulators/world";
import { describe, expect, it, vi } from "vitest";
import { renewalBrokenMs, renewalRetryMs } from "../src/workspace/renewal.ts";
import { notificationLifetimeMs } from "../src/workspace/store.ts";
import {
  connectBlueskyLive,
  connectThreadsLive,
  disconnected,
} from "./channels.ts";
import {
  adminEmail,
  blueskyClientKeys,
  credentialKeys,
  expectErrors,
  expectWarnings,
  signedIn,
  type TestSetup,
  urlOf,
} from "./helpers.ts";
import {
  ended,
  follow,
  gate,
  patience,
  publishTo,
  started,
  targetOf,
  writeDraft,
} from "./publishing.ts";
import { objectOf, SyncClient } from "./sync-client.ts";

/**
 * The access of a channel that is renewed by the timer of its workspace,
 * when the time comes that its adapter named, whether or not anybody
 * posts: `alarm` of src/workspace/object.ts and src/workspace/renewal.ts.
 * Threads needs it, whose token is renewed only while it is good, and
 * Bluesky has it too.
 */

const hour = 60 * 60 * 1000;
const day = 24 * hour;
const week = 7 * day;

const threadsRefresh = "GET https://graph.threads.net/refresh_access_token";
const threadsPublish = "POST https://graph.threads.net/v1.0/me/threads_publish";
const blueskyToken = "POST https://bsky.social/oauth/token";
const blueskyRevoke = "POST https://bsky.social/oauth/revoke";

/** How often the app has made `request` of a network, whatever its query. */
const asked = ({ network }: TestSetup, request: string) =>
  network.requests.filter((made) => made.replace(/\?.*$/, "") === request)
    .length;

/** What the workspace keeps of its one channel that no client sees. */
const kept = (workspaceId: string) =>
  runInDurableObject(objectOf(workspaceId), (_, state) =>
    state.storage.sql
      .exec<{ credentials: string | null; refresh_at: number | null }>(
        "select credentials, refresh_at from channel",
      )
      .one(),
  );

/**
 * In how many milliseconds the object of a workspace looks after it next,
 * or null if it has nothing to wait for. An alarm goes by the clock of
 * the runtime, which no test moves.
 */
const nextLookIn = async (workspaceId: string) => {
  const alarm = await runInDurableObject(objectOf(workspaceId), (_, state) =>
    state.storage.getAlarm(),
  );
  return alarm === null ? null : alarm - Date.now();
};

/** Has the object of a workspace look after it now, as its alarm does. */
const look = async (workspaceId: string) => {
  expect(await runDurableObjectAlarm(objectOf(workspaceId))).toBe(true);
};

// How far the time of an alarm may be off what a test expects: the test
// and the object read the clock of the runtime a moment apart.
const slack = 60 * 1000;

/** A channel of a network in a live workspace, with a client. */
async function withChannel(
  network: "threads" | "bluesky",
  options: Parameters<typeof started>[0] = {},
) {
  const context = await started(options);
  const { test, browser, workspaces } = context;
  const workspace = workspaces.live;
  const outcome = await (network === "threads"
    ? connectThreadsLive(test, browser, workspace)
    : connectBlueskyLive(test, browser, workspace));
  expect(outcome.connect).toBe("connected");
  await Promise.all(test.keptAlive);
  const client = new SyncClient();
  /**
   * The channel as a client sees it now. The socket of a client ends
   * minutes after it was opened, and the session of a person weeks after
   * they signed in, so the person signs in and the socket is opened anew.
   */
  const channel = async () => {
    await client.connect(
      await signedIn(test, { email: adminEmail }),
      workspace,
    );
    const [row] = client.table("channel");
    if (!row) throw new Error("The workspace has no channel");
    return row;
  };
  /** Publishes a post to the channel and returns how it ended. */
  const post = async (text: string) => {
    const { id } = await channel();
    const draft = await writeDraft(client, workspace, text);
    const [targetId = ""] = await publishTo(client, draft.postId, id);
    await ended(client, draft.postId);
    return targetOf(client, targetId);
  };
  return { ...context, workspace, client, channel, post };
}

describe("the access of a Threads channel", () => {
  it("is renewed when its time has come, with nobody posting, and is good past the end that it had", async () => {
    const context = await withChannel("threads");
    const { test, workspace } = context;
    const connectedAt = test.clock.time.getTime();
    const before = await kept(workspace);
    // The adapter asked for a week after the token was issued, and the
    // object has set its alarm for then.
    expect(before.refresh_at).toBe(connectedAt + week);
    expect(await nextLookIn(workspace)).toBeGreaterThan(week - slack);
    expect(await nextLookIn(workspace)).toBeLessThan(week + slack);

    test.advance(week);
    await look(workspace);

    expect(asked(test, threadsRefresh)).toBe(1);
    const after = await kept(workspace);
    expect(after.credentials).not.toBe(before.credentials);
    // A week after this refresh comes the next one.
    expect(after.refresh_at).toBe(connectedAt + 2 * week);
    expect(await nextLookIn(workspace)).toBeGreaterThan(week - slack);
    // Clients hear of the new end, and of nothing else: 60 days from the
    // refresh.
    expect(await context.channel()).toMatchObject({
      status: "connected",
      connectedAt: expect.any(Number),
      expiresAt: connectedAt + week + 60 * day,
    });

    // Past the end of the token that the account was connected with, a
    // post goes out with the one that the refresh returned.
    test.advance(54 * day);
    expect(await context.post("Two months later")).toMatchObject({
      status: "sent",
    });
  });

  it("is lost after 60 days when nothing renews it, which is what the timer is for", async () => {
    const context = await withChannel("threads");
    // No alarm has run in all that time.
    context.test.advance(60 * day);

    const target = await context.post("Too late");

    expect(target.status).toBe("error");
    expect(await context.channel()).toMatchObject({
      status: "needs_reconnect",
    });
  });

  it.each(["server-error", "lost-response"] as const)(
    "is asked for again an hour later after a %s of Threads",
    async (kind) => {
      const context = await withChannel("threads");
      const { test, workspace } = context;
      const warnings = expectWarnings();
      const before = await kept(workspace);
      test.advance(week);
      test.network.threads.arm({ kind, operation: "refresh" });

      await look(workspace);

      // Nothing has changed but the time of the next try.
      expect(await kept(workspace)).toEqual({
        credentials: before.credentials,
        refresh_at: test.clock.time.getTime() + renewalRetryMs,
      });
      expect(await nextLookIn(workspace)).toBeLessThan(renewalRetryMs + slack);
      expect(await nextLookIn(workspace)).toBeGreaterThan(
        renewalRetryMs - slack,
      );
      expect((await context.channel()).status).toBe("connected");
      expect(warnings).toHaveBeenCalledWith(
        expect.stringMatching(
          /^The access of the threads channel .* was not renewed: /,
        ),
      );

      test.advance(renewalRetryMs);
      await look(workspace);
      expect((await kept(workspace)).credentials).not.toBe(before.credentials);
      expect(asked(test, threadsRefresh)).toBe(2);
    },
  );

  it("marks the channel as one to connect again when Threads will not renew, and does not ask again", async () => {
    const context = await withChannel("threads");
    const { test, workspace } = context;
    const warnings = expectWarnings();
    // The person has removed pigy in the settings of their account.
    for (const { token } of test.network.world.tokens<SimToken>("threads")) {
      test.network.world.revokeToken("threads", token);
    }
    test.advance(week);

    await look(workspace);

    expect(await context.channel()).toMatchObject({
      status: "needs_reconnect",
    });
    expect(warnings).toHaveBeenCalled();
    // A channel that waits for its person has nothing to renew. The next
    // look is the inbox's, which has said that the account needs
    // connecting again and keeps that for 30 days: no reminder of the end
    // of this access is due before.
    expect(await nextLookIn(workspace)).toBeGreaterThan(
      notificationLifetimeMs - slack,
    );
    expect(await nextLookIn(workspace)).toBeLessThan(
      notificationLifetimeMs + slack,
    );
    expect(asked(test, threadsRefresh)).toBe(1);
  });

  it("waits a day when this pigy has lost the key that opens what it stored, and goes on when the key is back", async () => {
    const context = await withChannel("threads");
    const { test, workspace } = context;
    expectErrors();
    test.redeploy({ CREDENTIAL_KEYS: undefined });
    test.advance(week);

    await look(workspace);

    expect(asked(test, threadsRefresh)).toBe(0);
    expect((await kept(workspace)).refresh_at).toBe(
      test.clock.time.getTime() + renewalBrokenMs,
    );
    expect((await context.channel()).status).toBe("connected");

    test.redeploy({ CREDENTIAL_KEYS: credentialKeys });
    test.advance(renewalBrokenMs);
    await look(workspace);
    expect(asked(test, threadsRefresh)).toBe(1);
  });

  it("is not renewed while a delivery to the channel is under way, and is when that has ended", async () => {
    const publishing = gate((request) => request === threadsPublish);
    const context = await withChannel("threads", {
      interceptNetwork: publishing.intercept,
    });
    const { test, workspace, client } = context;
    // The access is due, and the object has not looked yet.
    test.advance(week);
    const { id } = await context.channel();
    const draft = await writeDraft(client, workspace, "On its way");
    publishing.close();
    const [targetId = ""] = await publishTo(client, draft.postId, id);
    // The alarm that began the delivery went on to the accesses, in the
    // same run, and found the one of this channel due. The delivery is in
    // the middle of its step that publishes.
    await publishing.reached();
    // And the object looks once more meanwhile, as it does every minute.
    await look(workspace);

    expect(asked(test, threadsRefresh)).toBe(0);
    publishing.open();
    await follow(client, () => targetOf(client, targetId).status === "sent");
    await look(workspace);
    expect(asked(test, threadsRefresh)).toBe(1);
  });
});

describe("an access whose renewal is overdue", () => {
  it("is renewed between two deliveries to its channel, which would else keep it waiting for as long as posts keep coming", async () => {
    const publishing = gate((request) => request === threadsPublish);
    const context = await withChannel("threads", {
      interceptNetwork: publishing.intercept,
    });
    const { test, workspace, client } = context;
    // Due for nearly a day, with nobody having looked: not overdue yet.
    test.advance(week + day - 60 * 1000);
    const { id } = await context.channel();
    const texts = ["First", "Second", "Third"];
    const drafts = [];
    for (const text of texts) {
      drafts.push(await writeDraft(client, workspace, text));
    }
    publishing.close();
    // The first delivery begins, and is held in the middle of its step
    // that publishes: the access is not renewed meanwhile.
    const targets: string[] = [];
    for (const draft of drafts) {
      const [targetId = ""] = await publishTo(client, draft.postId, id);
      targets.push(targetId);
      if (targets.length === 1) await publishing.reached();
    }
    // Two more wait behind it when the renewal becomes overdue.
    test.advance(2 * 60 * 1000);
    await context.channel();
    expect(asked(test, threadsRefresh)).toBe(0);

    publishing.open();
    await follow(client, () =>
      targets.every((targetId) => targetOf(client, targetId).status === "sent"),
    );
    // What the app asked of Threads, of these two requests, in order:
    // the renewal had its turn when the first delivery had ended, before
    // the second began, and not after the last of them.
    expect(
      test.network.requests
        .map((made) => made.replace(/\?.*$/, ""))
        .filter((made) => made === threadsPublish || made === threadsRefresh),
    ).toEqual([threadsPublish, threadsRefresh, threadsPublish, threadsPublish]);
    // And each delivery went out once, in the order in which it was asked for.
    expect(
      feed(test.network.world, ["threads"]).map(({ post }) => post.text),
    ).toEqual(texts);
  });
});

describe("the access of a Bluesky channel", () => {
  it("is renewed by the timer too, and the next post goes out with what the refresh returned", async () => {
    const context = await withChannel("bluesky");
    const { test, workspace } = context;
    const before = await kept(workspace);
    expect(before.refresh_at).toBe(test.clock.time.getTime() + week);
    const exchanges = asked(test, blueskyToken);

    test.advance(week);
    await look(workspace);

    // Bluesky has replaced the refresh token: what is stored now is all
    // that works.
    expect(asked(test, blueskyToken)).toBeGreaterThan(exchanges);
    const renewed = asked(test, blueskyToken);
    expect((await kept(workspace)).credentials).not.toBe(before.credentials);

    expect(await context.post("After a quiet week")).toMatchObject({
      status: "sent",
    });
    // The access token of the refresh is still good: the post asked for
    // no other.
    expect(asked(test, blueskyToken)).toBe(renewed);
    expect(
      feed(test.network.world, ["bluesky"]).map(({ post }) => post.text),
    ).toEqual(["After a quiet week"]);
  });

  it("waits a day when this pigy has lost the key that it signs with, and renews when the key is back", async () => {
    const context = await withChannel("bluesky");
    const { test, workspace } = context;
    const warnings = expectWarnings();
    const before = await kept(workspace);
    const exchanges = asked(test, blueskyToken);
    test.redeploy({ BLUESKY_CLIENT_KEYS: undefined });
    test.advance(week);

    await look(workspace);

    // Nothing was asked of Bluesky, so nothing is spent there, and the
    // channel is not one to connect again: the session is as good as it
    // was once the key is back.
    expect(asked(test, blueskyToken)).toBe(exchanges);
    expect(await kept(workspace)).toEqual({
      credentials: before.credentials,
      refresh_at: test.clock.time.getTime() + renewalBrokenMs,
    });
    expect((await context.channel()).status).toBe("connected");
    expect(warnings).toHaveBeenCalledWith(
      expect.stringMatching(
        /^The access of the bluesky channel .* was not renewed: /,
      ),
    );

    test.redeploy({ BLUESKY_CLIENT_KEYS: blueskyClientKeys });
    test.advance(renewalBrokenMs);
    await look(workspace);
    expect(asked(test, blueskyToken)).toBeGreaterThan(exchanges);
    expect((await kept(workspace)).credentials).not.toBe(before.credentials);
    expect((await context.channel()).status).toBe("connected");
  });

  it("gives back a renewed session that nothing holds, when the channel was disconnected while Bluesky was asked", async () => {
    // Holds the answer to a refresh back, after Bluesky has carried the
    // refresh out. The test and the object look at this on timers of
    // their own, as at a gate.
    const answer = { held: false, waiting: false };
    const context = await withChannel("bluesky", {
      interceptNetwork: (network) => async (input, init) => {
        const response = await network(input, init);
        // The answer with the tokens, and not the refusal before it that
        // only hands out a nonce.
        if (
          answer.held &&
          response.ok &&
          urlOf(input).endsWith("/oauth/token")
        ) {
          answer.waiting = true;
          while (answer.held) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        }
        return response;
      },
    });
    const { test, browser, workspace } = context;
    const { id } = await context.channel();
    test.advance(week);
    answer.held = true;
    const looking = runDurableObjectAlarm(objectOf(workspace));
    await vi.waitFor(() => expect(answer.waiting).toBe(true), patience);

    // The person disconnects the account meanwhile. The session that the
    // channel held is ended with the refresh token that it had.
    await disconnected(browser, workspace, id);
    const revocations = asked(test, blueskyRevoke);
    answer.held = false;
    await looking;

    // The channel is gone, so nothing took what the refresh returned:
    // tokens that would stand at Bluesky with nobody to end them. The
    // object has ended them itself.
    // Asked more than once: the first asking is refused for its nonce.
    expect(asked(test, blueskyRevoke)).toBeGreaterThan(revocations);
    expect(await nextLookIn(workspace)).toBeNull();
  });
});

describe("the alarm of a workspace", () => {
  it("fails when it cannot set the next one, so that the runtime runs it again, and sets it then", async () => {
    const context = await withChannel("threads");
    const { workspace } = context;
    expectErrors();
    // The storage of the object refuses once to set an alarm: the last
    // thing that the alarm does.
    await runInDurableObject(objectOf(workspace), (_, state) => {
      vi.spyOn(state.storage, "setAlarm").mockRejectedValueOnce(
        new Error("The storage is out of reach"),
      );
    });

    // An alarm that ended without a failure and without a next one would
    // be the last: nothing would renew an access or watch a delivery
    // until something else woke the object. The runtime runs an alarm
    // again that failed.
    await expect(runDurableObjectAlarm(objectOf(workspace))).rejects.toThrow(
      "The next look at a workspace was not set",
    );
    expect(await nextLookIn(workspace)).toBeNull();

    // The storage is back when the runtime tries again.
    await runInDurableObject(objectOf(workspace), (instance) =>
      instance.alarm(),
    );
    expect(await nextLookIn(workspace)).toBeGreaterThan(week - slack);
  });

  it("is set when a client says hello, for a workspace whose channel was connected before there was a timer", async () => {
    const context = await withChannel("threads");
    const { workspace } = context;
    // What such a workspace has: a channel with a time to renew at, and
    // no alarm.
    await runInDurableObject(objectOf(workspace), (_, state) =>
      state.storage.deleteAlarm(),
    );
    expect(await nextLookIn(workspace)).toBeNull();

    await context.channel();

    await vi.waitFor(
      async () =>
        expect(await nextLookIn(workspace)).toBeGreaterThan(week - slack),
      patience,
    );
  });

  it("leaves the accesses that are still due for later when a post waits to go out", async () => {
    const answer = { held: false, waiting: false };
    const publishing = gate((request) => request === threadsPublish);
    const context = await withChannel("bluesky", {
      interceptNetwork: (network) => {
        const gated = publishing.intercept(network);
        return async (input, init) => {
          const response = await gated(input, init);
          // Holds the answer of Bluesky to a refresh, as in the test of
          // a session that is given back.
          if (
            answer.held &&
            response.ok &&
            urlOf(input).endsWith("/oauth/token")
          ) {
            answer.waiting = true;
            while (answer.held) {
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
          }
          return response;
        };
      },
    });
    const { test, browser, workspace, client } = context;
    // A second channel, which the object turns to after the first.
    expect((await connectThreadsLive(test, browser, workspace)).connect).toBe(
      "connected",
    );
    await Promise.all(test.keptAlive);
    test.advance(week);
    await context.channel();
    const threads = client
      .table("channel")
      .find(({ network }) => network === "threads");
    const draft = await writeDraft(client, workspace, "Cannot wait");

    // Both are due. The object is in the middle of the first, which
    // waits for Bluesky.
    answer.held = true;
    publishing.close();
    // The runtime runs this alarm, and not the test by hand: publishing
    // sets the alarm for now, and the runtime runs one alarm of an object
    // at a time, so that one waits for this one, as it does in
    // production. Beside a look that the test ran by hand it would run
    // at once, begin the delivery and renew a second time with the
    // refresh token that the look had spent.
    await runInDurableObject(objectOf(workspace), (_, state) =>
      state.storage.setAlarm(Date.now()),
    );
    await vi.waitFor(() => expect(answer.waiting).toBe(true), patience);
    expect(asked(test, threadsRefresh)).toBe(0);
    // Meanwhile the person publishes to the other channel.
    const [targetId = ""] = await publishTo(
      client,
      draft.postId,
      threads?.id ?? "",
    );
    answer.held = false;

    // The delivery is in the middle of its step that publishes, and the
    // access of its channel was not renewed first: the post did not wait
    // for the renewal of the channel after the one that was under way.
    await publishing.reached();
    expect(asked(test, threadsRefresh)).toBe(0);

    // The rest is taken when the delivery has ended.
    publishing.open();
    await follow(client, () => targetOf(client, targetId).status === "sent");
    await look(workspace);
    expect(asked(test, threadsRefresh)).toBe(1);
  });
});
