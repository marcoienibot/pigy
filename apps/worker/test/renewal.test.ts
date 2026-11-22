import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { feed, type SimToken } from "@pigy/simulators/world";
import { describe, expect, it, vi } from "vitest";
import { renewalBrokenMs, renewalRetryMs } from "../src/workspace/renewal.ts";
import {
  connectBlueskyLive,
  connectThreadsLive,
  disconnected,
} from "./channels.ts";
import {
  adminEmail,
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
    // A channel that waits for its person has nothing to renew.
    expect(await nextLookIn(workspace)).toBeNull();
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
