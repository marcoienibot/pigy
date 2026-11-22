import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { metricMoments, type Row, targetLimits, uuidv7 } from "@pigy/core";
import { apiPostSchema } from "@pigy/core/api";
import { ProviderError } from "@pigy/providers";
import { blueskyAppViewHost } from "@pigy/simulators/bluesky";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { providerOf } from "../src/network/providers.ts";
import { metricsPauseMs, metricsPerPass } from "../src/workspace/object.ts";
import { metricsGraceMs, metricsRetryMs } from "../src/workspace/stats.ts";
import { metricsDueQuery, nextMetricsQuery } from "../src/workspace/store.ts";
import { makeKey, startedApi } from "./api.ts";
import {
  connectBlueskyLive,
  connectInSandbox,
  connectLinkedInLive,
  connectThreadsLive,
  disconnected,
} from "./channels.ts";
import { deployment } from "./clock.ts";
import {
  realMastodonDomain,
  type TestSetup,
  vapidPrivateKey,
} from "./helpers.ts";
import {
  connectAccount,
  ended,
  follow,
  gate,
  patience,
  postOf,
  publishTo,
  started,
  writeDraft,
} from "./publishing.ts";
import { idle, received, turnOn } from "./push.ts";
import { objectOf, SyncClient } from "./sync-client.ts";

/**
 * The stats of a delivery that is sent, which the object of its workspace
 * reads by its alarm: `#metricsPass` of src/workspace/object.ts and
 * src/workspace/stats.ts. The reads are at the moments of `metricMoments`
 * after the delivery was sent, by the clock of the test, which a test
 * moves and then runs the alarm, as the tests of the renewal of an access
 * do: the alarm itself goes by the clock of the runtime.
 */

const minute = 60 * 1000;
const hour = 60 * minute;
const day = 24 * hour;

/** Has the object of a workspace look after it now, as its alarm does. */
const look = async (workspaceId: string) => {
  expect(await runDurableObjectAlarm(objectOf(workspaceId))).toBe(true);
};

/**
 * In how many milliseconds the object looks after its workspace next, or
 * null if it has nothing to wait for. By the clock of the runtime.
 */
const nextLookIn = async (workspaceId: string) => {
  const alarm = await runInDurableObject(objectOf(workspaceId), (_, state) =>
    state.storage.getAlarm(),
  );
  return alarm === null ? null : alarm - Date.now();
};

/**
 * What the workspace has of the stats of a delivery: the synced row, if
 * there is one, and when it reads them next, which no client sees.
 */
const stored = (workspaceId: string, targetId: string) =>
  runInDurableObject(objectOf(workspaceId), (_, state) => {
    const [metric] = state.storage.sql
      .exec<Record<string, string | number | null>>(
        "select * from metric where id = ?",
        targetId,
      )
      .toArray();
    const { metrics_at: next } = state.storage.sql
      .exec<{ metrics_at: number | null }>(
        "select metrics_at from post_target where id = ?",
        targetId,
      )
      .one();
    return { metric, next };
  });

/** How often the app has asked the networks of `test` for something. */
const askedFor = ({ network }: TestSetup, what: (request: string) => boolean) =>
  network.requests.filter(what).length;

/** A request for a status of the Mastodon that stands for a real one. */
const readsStatus = (request: string) =>
  request.startsWith(`GET https://${realMastodonDomain}/api/v1/statuses/`) &&
  /\/statuses\/\d+$/.test(request);

/**
 * A live workspace with a channel of `network`, and a way to publish to it
 * that returns the target and what the post is on the network.
 */
async function sending(
  network: "mastodon" | "bluesky" | "linkedin" | "threads" = "mastodon",
  options: Parameters<typeof started>[0] = {},
) {
  const context = await started(options);
  const { test, browser, workspaces } = context;
  const workspace = workspaces.live;
  const connect = {
    bluesky: connectBlueskyLive,
    linkedin: connectLinkedInLive,
    threads: connectThreadsLive,
  } as const;
  const channelId =
    network === "mastodon"
      ? await connectAccount(test, browser, workspace)
      : ((await connect[network](test, browser, workspace)).channel ?? "");
  await Promise.all(test.keptAlive);
  const client = new SyncClient();
  await client.connect(browser, workspace);
  /** Publishes a post and returns its target once it is sent. */
  const post = async (...texts: [string, ...string[]]) => {
    const draft = await writeDraft(client, workspace, ...texts);
    const [targetId = ""] = await publishTo(client, draft.postId, channelId);
    expect((await ended(client, draft.postId)).status).toBe("sent");
    // What each part is on the network, in the order of the parts.
    const remoteIds = client
      .table("target_part_result")
      .filter((result) => result.targetId === targetId)
      .sort(
        (a, b) =>
          draft.partIds.indexOf(a.partId) - draft.partIds.indexOf(b.partId),
      )
      .map(({ remoteId }) => remoteId ?? "");
    // When it was sent, which the moments of reading go by: the time of
    // the mutation that ended it, which can be a little after the clock.
    const sentAt =
      client.table("post_target").find(({ id }) => id === targetId)?.sentAt ??
      0;
    return {
      ...draft,
      targetId,
      sentAt,
      remoteId: remoteIds[0] ?? "",
      remoteIds,
    };
  };
  /** The row of the stats of a target, once the client has one. */
  const metricOf = async (targetId: string) => {
    await follow(client, () =>
      client.table("metric").some(({ id }) => id === targetId),
    );
    return client.table("metric").find(({ id }) => id === targetId);
  };
  return { ...context, workspace, channelId, client, post, metricOf };
}

describe("the stats of a delivery", () => {
  it("are read at once when it is sent, at each moment after, and never after the last", async () => {
    const { test, workspace, post, metricOf } = await sending();

    const { targetId, remoteId, sentAt } = await post("Counted");

    // The alarm that the end of the delivery brought reads them at once,
    // and the client hears of them like of any change.
    expect(await metricOf(targetId)).toEqual({
      id: targetId,
      status: "counted",
      likes: 0,
      reposts: 0,
      replies: 0,
      quotes: 0,
      views: null,
      countedAt: expect.any(Number),
      reason: null,
    } satisfies Row<"metric">);
    expect(askedFor(test, readsStatus)).toBe(1);
    expect((await stored(workspace, targetId)).next).toBe(
      sentAt + (metricMoments[1] ?? 0),
    );

    // People like the post meanwhile, which the next read finds.
    test.network.world.engage("mastodon", remoteId, { likes: 4, reposts: 1 });
    for (const moment of metricMoments.slice(1)) {
      test.clock.time = new Date(sentAt + moment);
      await look(workspace);
    }

    expect((await stored(workspace, targetId)).metric).toMatchObject({
      status: "counted",
      likes: 4,
      reposts: 1,
      counted_at: test.clock.time.getTime(),
    });
    // One read for each moment, and nothing more to read.
    expect(askedFor(test, readsStatus)).toBe(metricMoments.length);
    expect((await stored(workspace, targetId)).next).toBeNull();
  });

  it("are read at the moment that is ahead after a time in which nothing read them, and not once for each moment that passed", async () => {
    const { test, workspace, post, metricOf } = await sending();
    const { targetId, sentAt } = await post("Counted");
    await metricOf(targetId);

    // Two days without an alarm: the moments of an hour, six hours and a
    // day have passed.
    test.clock.time = new Date(sentAt + 2 * day);
    await look(workspace);

    expect(askedFor(test, readsStatus)).toBe(2);
    expect((await stored(workspace, targetId)).next).toBe(sentAt + 3 * day);
  });

  it("are of the first part of a thread", async () => {
    const { test, workspace, post, metricOf } = await sending();
    const { targetId, sentAt, remoteIds } = await post(
      "First",
      "Second",
      "Third",
    );
    const [first = "", second = "", third = ""] = remoteIds;
    await metricOf(targetId);

    // People like each part a different number of times: what is read
    // is what they did with the first, and nothing is added up.
    test.network.world.engage("mastodon", first, { likes: 2 });
    test.network.world.engage("mastodon", second, { likes: 5 });
    test.network.world.engage("mastodon", third, { likes: 7 });
    test.clock.time = new Date(sentAt + (metricMoments[1] ?? 0));
    await look(workspace);

    // The second part is a reply of the account itself, which Mastodon
    // counts among the replies of the first: the only reply to it here.
    expect((await stored(workspace, targetId)).metric).toMatchObject({
      likes: 2,
      replies: 1,
    });
    // Both reads were of the status that the first part is.
    const read = test.network.requests.filter(readsStatus);
    expect(read).toEqual([
      `GET https://${realMastodonDomain}/api/v1/statuses/${first}`,
      `GET https://${realMastodonDomain}/api/v1/statuses/${first}`,
    ]);
  });

  it("count on Threads every part of a thread after the first among its replies, as Threads does", async () => {
    const { post, metricOf } = await sending("threads");

    const { targetId } = await post("First", "Second", "Third");

    // Threads counts under the post that begins a thread every reply in
    // the thread: the second part, and the third, which replies to it.
    expect((await metricOf(targetId))?.replies).toBe(2);
  });

  it("are not read again for a post that was deleted on the network, which they say", async () => {
    const { test, workspace, post, metricOf } = await sending();
    const { targetId, remoteId, sentAt } = await post("Counted");
    await metricOf(targetId);
    test.network.world.engage("mastodon", remoteId, { likes: 2 });
    test.clock.time = new Date(sentAt + hour);
    await look(workspace);

    // As the person does on the network.
    test.network.world.posts("mastodon").delete(remoteId);
    test.clock.time = new Date(sentAt + 6 * hour);
    await look(workspace);

    // The counts that were read last stay, with their time.
    expect(await stored(workspace, targetId)).toEqual({
      metric: expect.objectContaining({
        status: "gone",
        likes: 2,
        counted_at: sentAt + hour,
      }),
      next: null,
    });
    test.clock.time = new Date(sentAt + 30 * day);
    expect(await nextLookIn(workspace)).toBeNull();
    expect(askedFor(test, readsStatus)).toBe(3);
  });

  it("are asked for later where the network asks to be asked later, with the other reads of its channel", async () => {
    const { test, workspace, post, metricOf } = await sending();
    const first = await post("First");
    const second = await post("Second");
    await metricOf(first.targetId);
    await metricOf(second.targetId);
    const before = askedFor(test, readsStatus);
    // When the reads of an hour of both are due.
    const sentAt = second.sentAt;
    test.clock.time = new Date(sentAt + hour);
    test.network.mastodon.arm({ kind: "rate-limit", operation: "read" });

    await look(workspace);

    // One request, which was refused: the other read of the channel was
    // not asked for in the same pass, and both wait an hour, the refused
    // one a moment longer, so that the other comes first then.
    expect(askedFor(test, readsStatus)).toBe(before + 1);
    expect((await stored(workspace, first.targetId)).next).toBe(
      sentAt + hour + metricsRetryMs + 1,
    );
    expect((await stored(workspace, second.targetId)).next).toBe(
      sentAt + hour + metricsRetryMs,
    );
    // Not at once, which would ask the network again in the same breath.
    expect(await nextLookIn(workspace)).toBeGreaterThan(
      metricsRetryMs - minute,
    );

    test.clock.time = new Date(sentAt + hour + metricsRetryMs + 1);
    await look(workspace);
    expect(askedFor(test, readsStatus)).toBe(before + 3);
  });

  it("are read for the other posts of a channel after their network asked to be asked later about one of them, before that one", async () => {
    // A server that fails for one status, and for that one alone, as it
    // does for a status whose page it cannot build.
    const failing = new Set<string>();
    const { test, workspace, post, metricOf } = await sending("mastodon", {
      interceptNetwork: (network) => async (input, init) => {
        const request = new Request(input, init);
        const id = new URL(request.url).pathname.split("/").at(-1) ?? "";
        return readsStatus(`GET ${request.url}`) && failing.has(id)
          ? Response.json({ error: "Internal server error" }, { status: 500 })
          : network(request);
      },
    });
    // The one that fails is the first that is read where both are due at
    // the same time: its ID comes first, as the ID of a target begins with
    // the time on the clock of the test, which moves on in between.
    const refused = await post("Refused");
    test.clock.time = new Date(test.clock.time.getTime() + 1000);
    const other = await post("Other");
    expect(refused.targetId < other.targetId).toBe(true);
    await metricOf(refused.targetId);
    await metricOf(other.targetId);
    failing.add(refused.remoteId);
    const otherReads = (request: string) =>
      readsStatus(request) && request.endsWith(`/${other.remoteId}`);

    // At the hour, the read of the first is refused, and the network asks
    // to be asked later: the other read of the channel waits with it.
    const at = other.sentAt + hour;
    test.clock.time = new Date(at);
    await look(workspace);
    const before = askedFor(test, otherReads);

    // An hour later both are due. The network is asked about the other
    // first: the refused one would be refused again, and put the other
    // off once more, every hour for a month.
    test.clock.time = new Date(at + metricsRetryMs + minute);
    await look(workspace);

    expect(askedFor(test, otherReads)).toBe(before + 1);
    expect((await stored(workspace, other.targetId)).next).toBe(
      other.sentAt + (metricMoments[3] ?? 0),
    );
  });

  it("are read for the other posts of a channel while its network does not show one of them, which waits by itself", async () => {
    // Bluesky's app view does not show a post that its moderators took
    // down, which its PDS still has: the adapter asks to be tried again
    // for that post. Which one it is, the world says once it is there.
    let shown = (_uri: string) => true;
    const context = await sending("bluesky", {
      interceptNetwork: (network) => async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        const uri = url.searchParams.get("uris");
        return url.host === blueskyAppViewHost && uri !== null && !shown(uri)
          ? Response.json({ posts: [] })
          : network(request);
      },
    });
    const { test, workspace, post, metricOf } = context;
    shown = (uri) =>
      test.network.world.posts("bluesky").get(uri)?.text !== "Taken down";
    const reads = () =>
      test.network.requests.filter((request) =>
        request.startsWith(`GET https://${blueskyAppViewHost}/`),
      ).length;

    // The hidden one first: its read comes first whenever the reads of
    // the channel are due together.
    const hidden = await post("Taken down");
    const others = [await post("First"), await post("Second")];
    for (const { targetId } of others) await metricOf(targetId);
    // Read at once, and not shown.
    await vi.waitFor(() => expect(reads()).toBe(3), patience);
    expect(await stored(workspace, hidden.targetId)).toEqual({
      metric: undefined,
      next: hidden.sentAt + (metricMoments[1] ?? 0),
    });

    // People like the others meanwhile. The next moment of all three has
    // come, the hidden post's first.
    for (const { remoteId } of others) {
      test.network.world.engage("bluesky", remoteId, { likes: 3 });
    }
    const last = others.at(-1)?.sentAt ?? 0;
    test.clock.time = new Date(last + (metricMoments[1] ?? 0));
    await look(workspace);

    // The others are read, and the network is not rested for the one
    // post that it does not show, which waits for its own next moment.
    for (const { targetId } of others) {
      expect((await stored(workspace, targetId)).metric).toMatchObject({
        status: "counted",
        likes: 3,
      });
    }
    expect((await stored(workspace, hidden.targetId)).next).toBe(
      hidden.sentAt + (metricMoments[2] ?? 0),
    );

    // At the last moment, still not shown, its stats are given up, and
    // say why: no read is left that could find them.
    test.clock.time = new Date(hidden.sentAt + (metricMoments.at(-1) ?? 0));
    await look(workspace);
    expect(await stored(workspace, hidden.targetId)).toEqual({
      metric: expect.objectContaining({
        status: "unavailable",
        reason: "Bluesky does not show this post yet, or no longer.",
        likes: null,
      }),
      next: null,
    });
  });

  it("are given up a day after their last moment where the network keeps asking to be asked later, and say so with the counts of before", async () => {
    // What a network does that keeps asking to be asked later.
    const limited = { on: false };
    const { test, workspace, post, metricOf } = await sending("mastodon", {
      interceptNetwork: (network) => async (input, init) => {
        const request = new Request(input, init);
        return limited.on && readsStatus(`GET ${request.url}`)
          ? Response.json({ error: "Too many requests" }, { status: 429 })
          : network(request);
      },
    });
    const { targetId, remoteId, sentAt } = await post("Counted");
    await metricOf(targetId);
    test.network.world.engage("mastodon", remoteId, { likes: 2 });
    const countedAt = sentAt + (metricMoments[1] ?? 0);
    test.clock.time = new Date(countedAt);
    await look(workspace);
    limited.on = true;
    const last = sentAt + (metricMoments.at(-1) ?? 0);

    // Late for the last moment, and put off: still within the day. A
    // moment after the rest of its channel, which other reads would
    // have waited for.
    test.clock.time = new Date(last + metricsGraceMs - metricsRetryMs);
    await look(workspace);
    expect((await stored(workspace, targetId)).next).toBe(
      last + metricsGraceMs + 1,
    );

    // Put off once more, past it: never again, and the stats say why,
    // with the last counts that were read. A script that waits for them
    // to be anything but null would otherwise wait for good.
    test.clock.time = new Date(last + metricsGraceMs + 1);
    await look(workspace);
    expect(await stored(workspace, targetId)).toEqual({
      metric: expect.objectContaining({
        status: "unavailable",
        likes: 2,
        counted_at: countedAt,
        reason:
          "Mastodon did not answer for the stats of this post when pigy last asked, 30 days after it was sent.",
      }),
      next: null,
    });
  });

  it("put off the other reads of a channel with one that its network asks to be asked later, also where that one is given up", async () => {
    // A network that keeps asking to be asked later about one post.
    const limited = new Set<string>();
    const { test, workspace, post, metricOf } = await sending("mastodon", {
      interceptNetwork: (network) => async (input, init) => {
        const request = new Request(input, init);
        const id = new URL(request.url).pathname.split("/").at(-1) ?? "";
        return readsStatus(`GET ${request.url}`) && limited.has(id)
          ? Response.json({ error: "Too many requests" }, { status: 429 })
          : network(request);
      },
    });
    const given = await post("Given up");
    const other = await post("Other");
    await metricOf(given.targetId);
    await metricOf(other.targetId);
    limited.add(given.remoteId);
    const before = askedFor(test, readsStatus);

    // A day after the last moment of both, the first is read first, and
    // is put off past what is read at all.
    const at = given.sentAt + (metricMoments.at(-1) ?? 0) + metricsGraceMs;
    test.clock.time = new Date(at);
    await look(workspace);

    expect((await stored(workspace, given.targetId)).metric).toMatchObject({
      status: "unavailable",
    });
    // The network said to ask it later: the other read of the channel
    // waits for that, and is not made by an alarm that comes back at once.
    expect(askedFor(test, readsStatus)).toBe(before + 1);
    expect((await stored(workspace, other.targetId)).next).toBe(
      at + metricsRetryMs,
    );
  });

  it("say that the account has to be connected again where it does, without asking its network, and read at the next moment all the same", async () => {
    const { test, workspace, post, metricOf } = await sending();
    const { targetId, sentAt } = await post("Counted");
    await metricOf(targetId);
    // Its network has refused its access since, which publishing found.
    await runInDurableObject(objectOf(workspace), (_, state) => {
      state.storage.sql.exec("update channel set status = 'needs_reconnect'");
    });
    const before = askedFor(test, readsStatus);

    test.clock.time = new Date(sentAt + (metricMoments[1] ?? 0));
    await look(workspace);

    expect(await stored(workspace, targetId)).toEqual({
      metric: expect.objectContaining({
        status: "unavailable",
        // What was read before stays.
        likes: 0,
        reason:
          "The account has to be connected again: pigy reads its stats once it is.",
      }),
      next: sentAt + (metricMoments[2] ?? 0),
    });
    expect(askedFor(test, readsStatus)).toBe(before);
  });

  it("say at their last moment that the account had to be connected again then, and promise no read that never comes", async () => {
    const { test, workspace, post, metricOf } = await sending();
    const { targetId, sentAt } = await post("Counted");
    await metricOf(targetId);
    await runInDurableObject(objectOf(workspace), (_, state) => {
      state.storage.sql.exec("update channel set status = 'needs_reconnect'");
    });

    test.clock.time = new Date(sentAt + (metricMoments.at(-1) ?? 0));
    await look(workspace);

    // Nothing reads them again, also once the account is connected
    // again, which brings forward only the reads that are ahead.
    expect(await stored(workspace, targetId)).toEqual({
      metric: expect.objectContaining({
        status: "unavailable",
        reason:
          "The account had to be connected again when pigy last looked for the stats of this post, 30 days after it was sent.",
      }),
      next: null,
    });
  });

  it("are unavailable on LinkedIn whatever becomes of its account", async () => {
    const { test, workspace, post, metricOf } = await sending("linkedin");
    const { targetId } = await post("Not counted");
    await metricOf(targetId);
    // As if the first read had yet to come, and the account had to be
    // connected again meanwhile.
    await runInDurableObject(objectOf(workspace), (_, state) => {
      const { sql } = state.storage;
      sql.exec("update channel set status = 'needs_reconnect'");
      sql.exec("delete from metric where id = ?", targetId);
      sql.exec(
        "update post_target set metrics_at = ? where id = ?",
        test.clock.time.getTime(),
        targetId,
      );
    });

    await look(workspace);

    // Connecting it again would change nothing.
    expect(await stored(workspace, targetId)).toEqual({
      metric: expect.objectContaining({
        status: "unavailable",
        reason: "LinkedIn does not give pigy the stats of its posts.",
      }),
      next: null,
    });
  });

  it("say that the account was disconnected, with what was read before, and are read no more", async () => {
    const { test, browser, workspace, channelId, post, metricOf } =
      await sending();
    const { targetId, sentAt } = await post("Counted");
    await metricOf(targetId);
    await disconnected(browser, workspace, channelId);
    const before = askedFor(test, readsStatus);

    test.clock.time = new Date(sentAt + (metricMoments[1] ?? 0));
    await look(workspace);

    expect(await stored(workspace, targetId)).toEqual({
      metric: expect.objectContaining({
        status: "unavailable",
        likes: 0,
        reason:
          "The account was disconnected from pigy, which reads the stats of its posts no more.",
      }),
      next: null,
    });
    expect(askedFor(test, readsStatus)).toBe(before);
  });

  it("say that pigy does not know the post where the workspace has no record of it", async () => {
    const { test, workspace, post, metricOf } = await sending();
    const { targetId, sentAt } = await post("Counted");
    await metricOf(targetId);
    // What the delivery published, which nothing else forgets.
    await runInDurableObject(objectOf(workspace), (_, state) => {
      state.storage.sql.exec(
        "delete from target_part_result where target_id = ?",
        targetId,
      );
    });

    test.clock.time = new Date(sentAt + (metricMoments[1] ?? 0));
    await look(workspace);

    expect(await stored(workspace, targetId)).toEqual({
      metric: expect.objectContaining({
        status: "unavailable",
        reason:
          "pigy has no record of the post that this delivery made on Mastodon.",
      }),
      next: null,
    });
  });

  it("keep no post waiting while their network is slow to answer", async () => {
    const held = gate(readsStatus);
    const { post, metricOf } = await sending("mastodon", {
      interceptNetwork: held.intercept,
    });
    held.close();

    // Its first read waits at the gate, in the pass that the alarm began.
    const first = await post("First");
    await held.reached();

    // A post that is published meanwhile goes out all the same: the alarm
    // stops waiting for the pass, and begins the delivery. `post` fails
    // if it does not end.
    const second = await post("Second");
    expect(second.sentAt).toBeGreaterThan(first.sentAt);

    held.open();
    expect(await metricOf(first.targetId)).toMatchObject({
      status: "counted",
    });
  });

  it("keep no scheduled post waiting past its time while their network is slow to answer", async () => {
    const held = gate(readsStatus);
    const { test, client, workspace, channelId, post, metricOf } =
      await sending("mastodon", { interceptNetwork: held.intercept });
    // A post for a moment from now: less than the test client waits for
    // a message.
    const later = await writeDraft(client, workspace, "Later");
    const dueAt = test.clock.time.getTime() + 500;
    client.send({
      type: "mutate",
      mutations: [
        client.mutation("target.add", {
          id: uuidv7(test.clock.time),
          postId: later.postId,
          channelId,
        }),
        client.mutation("post.schedule", { id: later.postId, dueAt }),
      ],
    });
    expect((await client.patch()).rejected).toEqual([]);
    held.close();

    // The first read of another post waits at the gate, in the pass that
    // the alarm began, and the alarm with it.
    const first = await post("First");
    await held.reached();

    // The time of the scheduled post comes, which is no change that the
    // object hears of: the alarm stops waiting for the pass at that time,
    // and takes the post up.
    test.clock.time = new Date(dueAt);
    await follow(client, () => postOf(client, later.postId).status === "sent");

    held.open();
    expect(await metricOf(first.targetId)).toMatchObject({
      status: "counted",
    });
  });

  it("keep no push message waiting while their network is slow to answer", async () => {
    onTestFinished(idle);
    const held = gate(readsStatus);
    const { test, browser, client, workspace, channelId, post, metricOf } =
      await sending("mastodon", {
        interceptNetwork: held.intercept,
        env: { VAPID_PRIVATE_KEY: vapidPrivateKey },
      });
    const subscription = await turnOn(test, browser);
    held.close();
    const first = await post("First");
    await held.reached();

    // A post that fails meanwhile, which the devices are told of.
    test.network.mastodon.arm({ kind: "token-revoked", operation: "publish" });
    const failing = await writeDraft(client, workspace, "Refused");
    await publishTo(client, failing.postId, channelId);
    expect((await ended(client, failing.postId)).status).toBe("error");

    // Before the read at the gate is over: the alarm stopped waiting for
    // it when the message was queued, and sent the message.
    const messages = await received(test, subscription, 2);
    expect(messages.map(({ kind }) => kind).sort()).toEqual([
      "channel_needs_reconnect",
      "post_failed",
    ]);

    // The read that waited goes on with the access that the network has
    // taken back since, and says so.
    held.open();
    expect(await metricOf(first.targetId)).toMatchObject({
      status: "unavailable",
    });
  });

  it("keep the renewal of an access for the alarm after them while their network is slow to answer, which they do not stop for", async () => {
    const held = gate((request) => request.includes("/insights"));
    const { test, workspace, post, metricOf } = await sending("threads", {
      interceptNetwork: held.intercept,
    });
    const renews = (request: string) =>
      request.startsWith("GET https://graph.threads.net/refresh_access_token");
    const { targetId, sentAt } = await post("Counted");
    await metricOf(targetId);
    const at = sentAt + (metricMoments[1] ?? 0);
    // The access of the channel is due for renewal a moment after the
    // read of ten minutes has begun.
    const renewal = at + 50;
    await runInDurableObject(objectOf(workspace), (_, state) => {
      state.storage.sql.exec("update channel set refresh_at = ?", renewal);
    });
    held.close();
    test.clock.time = new Date(at);
    let over = false;
    const looking = look(workspace).then(() => {
      over = true;
    });
    await held.reached();

    // The alarm waits for the read through the time of the renewal: an
    // access is good for weeks, and the pass ends within a minute and a
    // half. A wait that stopped there stopped only some of the time, as
    // it went on with the wait for the stats where it had stopped the one
    // for the push messages. No change comes that it could stop for, so
    // the test gives it time, by the clock of the runtime, which it would
    // have stopped by.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(over).toBe(false);
    held.open();
    await looking;
    expect((await stored(workspace, targetId)).metric).toMatchObject({
      status: "counted",
    });
    expect(askedFor(test, renews)).toBe(0);

    // The alarm after the pass turns to it.
    test.clock.time = new Date(renewal);
    await look(workspace);
    expect(askedFor(test, renews)).toBe(1);
  });

  it("are unavailable where the network has none for pigy, without asking it", async () => {
    const { test, workspace, post, metricOf } = await sending("linkedin");

    const { targetId } = await post("Not counted");
    const after = test.network.requests.length;

    expect(await metricOf(targetId)).toMatchObject({
      status: "unavailable",
      likes: null,
      countedAt: null,
      reason: "LinkedIn does not give pigy the stats of its posts.",
    });
    expect((await stored(workspace, targetId)).next).toBeNull();
    expect(test.network.requests.length).toBe(after);
  });

  it("are unavailable for a Threads account that was connected before pigy asked to read them, and come once it is connected again", async () => {
    // What Threads answers a token without the permission to read
    // insights, which every account that was connected before has.
    const lacking = { on: true };
    const { test, browser, client, workspace, post, metricOf } = await sending(
      "threads",
      {
        interceptNetwork: (network) => async (input, init) => {
          const request = new Request(input, init);
          return lacking.on && request.url.includes("/insights")
            ? Response.json(
                {
                  error: {
                    message:
                      "(#10) Application does not have permission for this action",
                    type: "THApiException",
                    code: 10,
                  },
                },
                { status: 403 },
              )
            : network(request);
        },
      },
    );
    const { targetId } = await post("Counted");

    expect(await metricOf(targetId)).toMatchObject({
      status: "unavailable",
      reason:
        "Threads lets pigy read the stats of this account once it is connected again.",
    });
    // The channel is fine for posting, and is not marked.
    const channel = await runInDurableObject(objectOf(workspace), (_, state) =>
      state.storage.sql
        .exec<{ status: string }>("select status from channel")
        .one(),
    );
    expect(channel.status).toBe("connected");

    // The person connects the account again, which grants the permission.
    // Its stats are read then, and not at their next moment, which can be
    // weeks away: the clock of the test does not move.
    lacking.on = false;
    await connectThreadsLive(test, browser, workspace);

    await follow(
      client,
      () =>
        client.table("metric").find(({ id }) => id === targetId)?.status ===
        "counted",
    );
    expect((await stored(workspace, targetId)).metric).toMatchObject({
      status: "counted",
      views: 0,
      reason: null,
    });
  });

  it("say at their last moment that the network gave none with the access, and promise no read that never comes", async () => {
    // What Threads answers a token without the permission to read
    // insights, whose message says that a new connection gives it.
    const { test, workspace, post, metricOf } = await sending("threads", {
      interceptNetwork: (network) => async (input, init) => {
        const request = new Request(input, init);
        return request.url.includes("/insights")
          ? Response.json(
              {
                error: {
                  message:
                    "(#10) Application does not have permission for this action",
                  type: "THApiException",
                  code: 10,
                },
              },
              { status: 403 },
            )
          : network(request);
      },
    });
    const { targetId, sentAt } = await post("Counted");
    await metricOf(targetId);

    test.clock.time = new Date(sentAt + (metricMoments.at(-1) ?? 0));
    await look(workspace);

    expect(await stored(workspace, targetId)).toEqual({
      metric: expect.objectContaining({
        status: "unavailable",
        reason:
          "Threads did not give pigy the stats of this post when it last asked, 30 days after it was sent.",
      }),
      next: null,
    });
  });

  it("are read with the new access of an account that is connected again while its network is asked with the old one", async () => {
    // What Threads answers a token without the permission to read
    // insights, decided when the request is made: one that waits at the
    // gate was made with the access before.
    const lacking = { on: true };
    const held = gate((request) => request.includes("/insights"));
    const { test, browser, workspace, post, metricOf } = await sending(
      "threads",
      {
        interceptNetwork: (network) => {
          const gated = held.intercept(network);
          return async (input, init) => {
            const request = new Request(input, init);
            const refused = lacking.on && request.url.includes("/insights");
            const answer = await gated(request);
            return refused
              ? Response.json(
                  {
                    error: {
                      message:
                        "(#10) Application does not have permission for this action",
                      type: "THApiException",
                      code: 10,
                    },
                  },
                  { status: 403 },
                )
              : answer;
          };
        },
      },
    );
    const { targetId, sentAt } = await post("Counted");
    expect(await metricOf(targetId)).toMatchObject({ status: "unavailable" });

    // The read of ten minutes waits for Threads, with the access before.
    held.close();
    test.clock.time = new Date(sentAt + (metricMoments[1] ?? 0));
    const looking = look(workspace);
    await held.reached();
    // Meanwhile the person connects the account again, which grants the
    // permission. That read was due already, so the connection has none
    // to bring forward.
    lacking.on = false;
    await connectThreadsLive(test, browser, workspace);
    await Promise.all(test.keptAlive);
    held.open();
    await looking;

    // Threads refused the access before, which says nothing of the new
    // one: the read is due still, for the next pass, and not put off to
    // its next moment, an hour after the post.
    expect((await stored(workspace, targetId)).next).toBeLessThanOrEqual(
      test.clock.time.getTime(),
    );
    await look(workspace);
    expect((await stored(workspace, targetId)).metric).toMatchObject({
      status: "counted",
      reason: null,
    });
  });

  it("say why there are none in as many words as they may have, whatever the network said", async () => {
    // What the network says is the reason: a message that is longer than
    // a reason may be, and one that is empty.
    const said = { message: "" };
    const { post, metricOf } = await sending();
    deployment.providerOf = (...args) => {
      const connection = providerOf(...args);
      return {
        ...connection,
        provider: {
          ...connection.provider,
          metrics: async () => {
            throw new ProviderError("fail", said.message);
          },
        },
      };
    };
    said.message = "Too long. ".repeat(targetLimits.errorLength / 5);

    const long = await post("Counted");
    const { reason } = (await metricOf(long.targetId)) ?? {};
    expect(reason).toHaveLength(targetLimits.errorLength);
    expect(said.message.startsWith(String(reason))).toBe(true);

    said.message = "";
    const empty = await post("Counted again");
    expect(await metricOf(empty.targetId)).toMatchObject({
      status: "unavailable",
      reason: "pigy could not read the stats of this post.",
    });
  });

  it("are asked for only of a delivery that is sent, by the alarm as by the pass", async () => {
    const { workspace, post, metricOf } = await sending();
    const { targetId, postId, sentAt } = await post("Counted");
    await metricOf(targetId);
    // A delivery that is not sent with a time to read its stats at, which
    // nothing makes: if anything did, the pass would read nothing of it,
    // and an alarm that came for it would come back at once for good.
    await runInDurableObject(objectOf(workspace), (_, state) => {
      const { sql } = state.storage;
      const { channel_id: channelId } = sql
        .exec<{ channel_id: string }>(
          "select channel_id from post_target where id = ?",
          targetId,
        )
        .one();
      const [post, target] = [1, 2].map(() => uuidv7(new Date(sentAt)));
      sql.exec(
        "insert into post (id, status, created_at, updated_at) select ?, 'error', created_at, updated_at from post where id = ?",
        post,
        postId,
      );
      sql.exec(
        "insert into post_target (id, post_id, channel_id, status, attempt, error, metrics_at) values (?, ?, ?, 'error', 1, 'Failed', ?)",
        target,
        post,
        channelId,
        sentAt,
      );
    });

    await look(workspace);

    // The alarm comes back for the next read of the delivery that is
    // sent, and not at once.
    expect(await nextLookIn(workspace)).toBeGreaterThan(
      (metricMoments[1] ?? 0) - minute,
    );
  });

  it("are read a few at a time in a workspace that has sent many posts at once", async () => {
    const { test, workspace, post, metricOf } = await sending();
    const { targetId, postId, remoteId, sentAt } = await post("Counted");
    await metricOf(targetId);
    // Many more deliveries of the same, which the workspace has sent at
    // the same time as this one: rows as the pipeline leaves them.
    const many = metricsPerPass + 5;
    await runInDurableObject(objectOf(workspace), (_, state) => {
      const { sql } = state.storage;
      const [target] = sql
        .exec<{ channel_id: string; sent_at: number }>(
          "select channel_id, sent_at from post_target where id = ?",
          targetId,
        )
        .toArray();
      for (let index = 0; index < many; index++) {
        const [post, part, target_, result] = [1, 2, 3, 4].map(() =>
          uuidv7(new Date(sentAt)),
        );
        sql.exec(
          "insert into post (id, status, created_at, updated_at) select ?, status, created_at, updated_at from post where id = ?",
          post,
          postId,
        );
        sql.exec(
          "insert into post_part (id, post_id, position, text) values (?, ?, 0, 'Counted')",
          part,
          post,
        );
        sql.exec(
          "insert into post_target (id, post_id, channel_id, status, attempt, sent_at, metrics_at) values (?, ?, ?, 'sent', 1, ?, ?)",
          target_,
          post,
          target?.channel_id,
          target?.sent_at,
          sentAt + hour,
        );
        sql.exec(
          "insert into target_part_result (id, target_id, part_id, remote_id) values (?, ?, ?, ?)",
          result,
          target_,
          part,
          remoteId,
        );
      }
    });
    test.clock.time = new Date(sentAt + hour);
    const before = askedFor(test, readsStatus);

    await look(workspace);

    // One pass reads as many as it may, and the next comes a while later
    // for the rest, which are due still.
    expect(askedFor(test, readsStatus)).toBe(before + metricsPerPass);
    const wait = await nextLookIn(workspace);
    expect(wait).toBeGreaterThan(metricsPauseMs - minute / 2);
    expect(wait).toBeLessThanOrEqual(metricsPauseMs);

    await look(workspace);
    // The rest, and the one that was published, whose read of an hour
    // was due with them.
    expect(askedFor(test, readsStatus)).toBe(before + many + 1);
  });

  it("are looked for in an index of the deliveries that are sent by the time of their next read, without going through the others", async () => {
    const { workspace, post } = await sending();
    // The workspace has its tables once it was used.
    await post("Counted");
    const plans = await runInDurableObject(objectOf(workspace), (_, state) => {
      const db = drizzle(state.storage);
      // What SQLite says that it does for the questions of the store.
      const planOf = (query: {
        toSQL(): { sql: string; params: unknown[] };
      }) => {
        const { sql, params } = query.toSQL();
        return state.storage.sql
          .exec<{ detail: string }>(`explain query plan ${sql}`, ...params)
          .toArray()
          .map(({ detail }) => detail);
      };
      return {
        next: planOf(nextMetricsQuery(db)),
        due: planOf(metricsDueQuery(db, Date.now(), metricsPerPass)),
      };
    });
    // Each is a search in the index under the status `sent`, from the
    // first time on: not a walk through every delivery that was ever
    // sent, which an index of the status alone has under one key, with a
    // sort of all of them for what is due. Every change asks for the next
    // time, and every pass for what is due. What is sorted is the reads
    // that are due at the same time, by their ID, which the index does
    // not have: a few at a time, up to the limit of the pass.
    expect(plans).toEqual({
      next: [
        "SEARCH post_target USING COVERING INDEX post_target_metrics_at_idx (status=?)",
      ],
      due: [
        "SEARCH post_target USING INDEX post_target_metrics_at_idx (status=? AND metrics_at>? AND metrics_at<?)",
        "USE TEMP B-TREE FOR LAST TERM OF ORDER BY",
      ],
    });
  });
});

describe("the stats in a sandbox", () => {
  it("are read from its simulated world, whose audience likes a post as time goes by, and nothing reaches a network", async () => {
    const { test, browser, workspaces } = await started();
    const workspace = workspaces.sandbox;
    const outcome = await connectInSandbox(browser, workspace);
    await Promise.all(test.keptAlive);
    const client = new SyncClient();
    await client.connect(browser, workspace);
    const draft = await writeDraft(client, workspace, "Counted");
    const [targetId = ""] = await publishTo(
      client,
      draft.postId,
      outcome.channel ?? "",
    );
    await ended(client, draft.postId);
    // By the time of the mutation that ended the delivery, which can be a
    // little after the clock.
    const sentAt =
      client.table("post_target").find(({ id }) => id === targetId)?.sentAt ??
      0;

    await follow(client, () =>
      client.table("metric").some(({ id }) => id === targetId),
    );
    // Nobody has seen the post yet.
    expect(client.table("metric")[0]).toMatchObject({
      status: "counted",
      likes: 0,
    });

    // Ten minutes later somebody has: a person who tries pigy sees the
    // counts move a few minutes after publishing. The Worker reads a
    // sandbox at the moments of every workspace.
    test.clock.time = new Date(sentAt + 10 * minute);
    await look(workspace);
    const early = (await stored(workspace, targetId)).metric;
    expect(early?.likes).toBeGreaterThan(0);

    test.clock.time = new Date(sentAt + day);
    await look(workspace);

    const { metric } = await stored(workspace, targetId);
    expect(metric?.likes).toBeGreaterThan(Number(early?.likes));
    expect(test.network.requests).toEqual([]);
  });
});

describe("the stats in the public API", () => {
  it("are said of each delivery once they are read, null before, and unavailable where the network has none", async () => {
    const context = await startedApi();
    const { test, browser, workspaces } = context;
    const workspace = workspaces.live;
    const mastodon = await connectAccount(test, browser, workspace);
    const linkedin =
      (await connectLinkedInLive(test, browser, workspace)).channel ?? "";
    await Promise.all(test.keptAlive);
    const { secret } = await makeKey(browser, workspace);
    const call = (
      path: string,
      init: { method?: string; json?: unknown } = {},
    ) =>
      test.browser().fetch(`/api/v1${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${secret}`, Origin: null },
      });

    const created = apiPostSchema.parse(
      await (
        await call("/posts", {
          method: "POST",
          json: {
            text: "Counted",
            channelIds: [mastodon, linkedin],
            mode: "shareNow",
          },
        })
      ).json(),
    );
    // On its way: nothing to say yet.
    expect(created.targets.map(({ metrics }) => metrics)).toEqual([null, null]);

    const post = await vi.waitFor(async () => {
      const read = apiPostSchema.parse(
        await (await call(`/posts/${created.id}`)).json(),
      );
      expect(read.targets.every(({ metrics }) => metrics !== null)).toBe(true);
      return read;
    }, patience);

    const of = (channelId: string) =>
      post.targets.find((target) => target.channelId === channelId)?.metrics;
    expect(of(mastodon)).toEqual({
      status: "counted",
      likes: 0,
      reposts: 0,
      replies: 0,
      quotes: 0,
      views: null,
      countedAt: expect.stringMatching(/^2026-11-14T10:00:/),
      reason: null,
    });
    expect(of(linkedin)).toEqual({
      status: "unavailable",
      likes: null,
      reposts: null,
      replies: null,
      quotes: null,
      views: null,
      countedAt: null,
      reason: "LinkedIn does not give pigy the stats of its posts.",
    });
  });
});
