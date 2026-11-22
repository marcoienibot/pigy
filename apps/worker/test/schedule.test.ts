import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { lateMs, type Row } from "@pigy/core";
import { feed } from "@pigy/simulators/world";
import { expect, it, vi } from "vitest";
import { deliveryWatchMs } from "../src/workspace/object.ts";
import { WorkspaceStore } from "../src/workspace/store.ts";
import { connectBlueskyLive } from "./channels.ts";
import { clock } from "./clock.ts";
import { type Browser, expectErrors } from "./helpers.ts";
import {
  connectAccount,
  follow,
  gate,
  patience,
  postOf,
  postStatus,
  started,
  targetOf,
  writeDraft,
} from "./publishing.ts";
import { newId, objectOf, SyncClient } from "./sync-client.ts";

/**
 * Scheduling in the object of a workspace: a post goes out when its time
 * has come, by the alarm of the object, which a test runs when it has
 * moved the clock. The times of posts are by the clock of the test. The
 * alarm is by the clock of the runtime, which nothing moves: the object
 * sets it as far ahead as the next post is.
 */

const minute = 60 * 1000;
const hour = 60 * minute;

/** The time on the clock of the test. */
const now = () => clock.time.getTime();

async function ready(options: Parameters<typeof started>[0] = {}) {
  const context = await started(options);
  const { test, browser, workspaces } = context;
  const workspace = workspaces.live;
  const channel = await connectAccount(test, browser, workspace);
  const client = await watching(browser, workspace);
  /** The texts that are on the network, in the order they were posted. */
  const posts = () => feed(test.network.world).map(({ post }) => post.text);
  return { ...context, workspace, channel, client, posts };
}

/**
 * A client of the workspace with a socket that was opened now. A socket
 * lasts five minutes by the clock of the test, so a test that has moved
 * the clock further looks through a new one.
 */
async function watching(browser: Browser, workspace: string) {
  const client = new SyncClient();
  await client.connect(browser, workspace);
  return client;
}

/** Sends mutations in one message, none of which may be refused. */
async function mutate(
  client: SyncClient,
  ...mutations: ReturnType<SyncClient["mutation"]>[]
) {
  client.send({ type: "mutate", mutations });
  const { rejected } = await client.patch();
  expect(rejected).toEqual([]);
}

/** Writes a post, chooses its channels and schedules it for `dueAt`. */
async function schedule(
  client: SyncClient,
  workspace: string,
  text: string,
  dueAt: number,
  ...channels: string[]
) {
  const { postId } = await writeDraft(client, workspace, text);
  const targets = channels.map(() => newId());
  await mutate(
    client,
    ...channels.map((channelId, index) =>
      client.mutation("target.add", {
        id: targets[index] ?? "",
        postId,
        channelId,
      }),
    ),
    client.mutation("post.schedule", { id: postId, dueAt }),
  );
  return { postId, targets };
}

/** Writes a post, chooses its channel and adds it to the queue. */
async function enqueue(
  client: SyncClient,
  workspace: string,
  text: string,
  channelId: string,
) {
  const { postId } = await writeDraft(client, workspace, text);
  await mutate(
    client,
    client.mutation("target.add", { id: newId(), postId, channelId }),
    client.mutation("post.enqueue", { id: postId, first: false }),
  );
  return postId;
}

/**
 * Gives the workspace slots at these numbers of minutes from now, on the
 * clocks of UTC, which is the time zone of a workspace that has set none.
 */
async function slotsIn(client: SyncClient, ...minutes: number[]) {
  await mutate(
    client,
    ...minutes.map((ahead) => {
      const time = new Date(now() + ahead * minute);
      return client.mutation("slot.add", {
        id: newId(),
        weekday: time.getUTCDay(),
        minute: time.getUTCHours() * 60 + time.getUTCMinutes(),
      });
    }),
  );
}

/** When the alarm of the workspace is set to, by the clock of the runtime. */
const alarmOf = (workspace: string) =>
  runInDurableObject(objectOf(workspace), (_, state) =>
    state.storage.getAlarm(),
  );

/** The posts of the workspace as its database has them. */
const stored = (workspace: string) =>
  runInDurableObject(objectOf(workspace), (_, state) =>
    state.storage.sql
      .exec<{ id: string; status: string; due_at: number | null }>(
        "select id, status, due_at from post order by created_at",
      )
      .toArray(),
  );

/** Runs the alarm of the workspace, which has to be set. */
async function alarm(workspace: string) {
  expect(await runDurableObjectAlarm(objectOf(workspace))).toBe(true);
}

/** Follows `client` until the post has gone out or failed. */
async function settled(client: SyncClient, postId: string) {
  const over = (post: Row<"post">) =>
    post.status === "sent" || post.status === "error";
  await follow(client, () => over(postOf(client, postId)));
  return postOf(client, postId);
}

it("publishes a scheduled post when its time has come, and not before", async () => {
  const { test, browser, workspace, channel, client, posts } = await ready();
  const dueAt = now() + hour;

  const { postId, targets } = await schedule(
    client,
    workspace,
    "At eleven",
    dueAt,
    channel,
  );

  expect(postOf(client, postId)).toMatchObject({
    status: "scheduled",
    mode: "custom",
    dueAt,
  });
  // Only chosen: the delivery is asked for when the post is due.
  expect(targetOf(client, targets[0] ?? "")).toMatchObject({
    status: "pending",
    queuedAt: null,
  });
  // The alarm is set an hour ahead, and nothing polls until then.
  const set = (await alarmOf(workspace)) ?? 0;
  expect(set - Date.now()).toBeGreaterThan(hour - minute);
  expect(set - Date.now()).toBeLessThanOrEqual(hour);

  // A minute before its time, an alarm finds nothing to do, and is set
  // again for the minute that is left.
  test.advance(hour - minute);
  await alarm(workspace);
  expect(await stored(workspace)).toMatchObject([{ status: "scheduled" }]);
  expect(posts()).toEqual([]);
  const again = (await alarmOf(workspace)) ?? 0;
  expect(again - Date.now()).toBeGreaterThan(0);
  expect(again - Date.now()).toBeLessThanOrEqual(minute);

  test.advance(minute);
  await alarm(workspace);

  const later = await watching(browser, workspace);
  expect(await settled(later, postId)).toMatchObject({
    status: "sent",
    // What said when it was to go out stays with the post.
    mode: "custom",
    dueAt,
  });
  expect(posts()).toEqual(["At eleven"]);
  expect(targetOf(later, targets[0] ?? "")).toMatchObject({
    status: "sent",
    // Asked for at the time of the post, by the clock of the test.
    queuedAt: dueAt,
  });
});

it("publishes a scheduled post to Mastodon and to Bluesky", async () => {
  const { test, browser, workspace, channel, client } = await ready();
  const bluesky = await connectBlueskyLive(test, browser, workspace);
  await client.patch();
  const dueAt = now() + 2 * minute;

  const { postId, targets } = await schedule(
    client,
    workspace,
    "To both",
    dueAt,
    channel,
    bluesky.channel ?? "",
  );
  test.advance(2 * minute);
  await alarm(workspace);

  expect(await settled(client, postId)).toMatchObject({ status: "sent" });
  for (const target of targets) {
    expect(targetOf(client, target)).toMatchObject({ status: "sent" });
  }
  // One post on each network.
  for (const network of ["mastodon", "bluesky"] as const) {
    expect(
      feed(test.network.world, [network]).map(({ post }) => post.text),
    ).toEqual(["To both"]);
  }
});

it("sets its alarm to the earliest scheduled post, whichever was scheduled first", async () => {
  const { workspace, channel, client } = await ready();
  const ahead = async () => ((await alarmOf(workspace)) ?? 0) - Date.now();

  await schedule(client, workspace, "Later", now() + 3 * hour, channel);
  expect(await ahead()).toBeGreaterThan(3 * hour - minute);

  // An earlier one brings the alarm forward.
  const sooner = await schedule(
    client,
    workspace,
    "Sooner",
    now() + hour,
    channel,
  );
  expect(await ahead()).toBeGreaterThan(hour - minute);
  expect(await ahead()).toBeLessThanOrEqual(hour);

  // Taken back, it leaves the alarm where it is: an alarm that comes
  // early does no harm. It finds nothing to do, and is set to the post
  // that is left.
  await mutate(
    client,
    client.mutation("post.unschedule", { id: sooner.postId }),
  );
  expect(await ahead()).toBeLessThanOrEqual(hour);
  await alarm(workspace);
  expect(await ahead()).toBeGreaterThan(3 * hour - minute);
  expect(await ahead()).toBeLessThanOrEqual(3 * hour);
});

it("sets no alarm for a workspace in which nothing is scheduled", async () => {
  const { workspace, channel, client } = await ready();
  const { postId } = await schedule(
    client,
    workspace,
    "Not after all",
    now() + hour,
    channel,
  );
  await mutate(client, client.mutation("post.unschedule", { id: postId }));

  // The alarm that the post left behind runs for nothing, once.
  await alarm(workspace);

  expect(await alarmOf(workspace)).toBeNull();
});

it("publishes the posts of the queue at their slots, in their order", async () => {
  const { test, browser, workspace, channel, client, posts } = await ready();
  await slotsIn(client, 10, 20, 30);
  const first = await enqueue(client, workspace, "First", channel);
  const second = await enqueue(client, workspace, "Second", channel);
  // Shared next: it takes the first slot, and the others move back.
  const { postId: urgent } = await writeDraft(client, workspace, "Urgent");
  await mutate(
    client,
    client.mutation("target.add", {
      id: newId(),
      postId: urgent,
      channelId: channel,
    }),
    client.mutation("post.enqueue", { id: urgent, first: true }),
  );
  const start = now();
  expect(
    [urgent, first, second].map(
      (id) => ((postOf(client, id).dueAt ?? 0) - start) / minute,
    ),
  ).toEqual([10, 20, 30]);

  test.advance(10 * minute);
  await alarm(workspace);
  let later = await watching(browser, workspace);
  expect(await settled(later, urgent)).toMatchObject({ status: "sent" });
  // The others wait for their own slots.
  expect(posts()).toEqual(["Urgent"]);
  expect(postOf(later, first).status).toBe("scheduled");

  test.advance(10 * minute);
  await alarm(workspace);
  later = await watching(browser, workspace);
  expect(await settled(later, first)).toMatchObject({ status: "sent" });
  expect(posts()).toEqual(["Urgent", "First"]);

  test.advance(10 * minute);
  await alarm(workspace);
  later = await watching(browser, workspace);
  expect(await settled(later, second)).toMatchObject({ status: "sent" });
  expect(posts()).toEqual(["Urgent", "First", "Second"]);
});

it("holds the queue while it is paused, sends a post with a time of its own all the same, and uses no slot that passed", async () => {
  const { test, browser, workspace, channel, client, posts } = await ready();
  await slotsIn(client, 10, 30);
  const queued = await enqueue(client, workspace, "Queued", channel);
  const exact = await schedule(
    client,
    workspace,
    "Exact",
    now() + 10 * minute,
    channel,
  );
  await mutate(client, client.mutation("queue.setPaused", { paused: true }));
  expect(postOf(client, queued)).toMatchObject({
    status: "scheduled",
    dueAt: null,
  });
  const start = now();

  // The first slot comes and goes.
  test.advance(10 * minute);
  await alarm(workspace);
  let later = await watching(browser, workspace);
  expect(await settled(later, exact.postId)).toMatchObject({ status: "sent" });
  expect(posts()).toEqual(["Exact"]);
  expect(postOf(later, queued)).toMatchObject({ status: "scheduled" });
  // Nothing of the workspace has a time now. The alarm that looked
  // after the delivery comes once more, and sets none after it.
  await alarm(workspace);
  expect(await alarmOf(workspace)).toBeNull();

  // The queue goes on five minutes after the slot that passed: the post
  // takes the next one, and does not go out for the one it missed.
  test.advance(5 * minute);
  later = await watching(browser, workspace);
  await mutate(later, later.mutation("queue.setPaused", { paused: false }));
  expect(postOf(later, queued).dueAt).toBe(start + 30 * minute);
  expect(posts()).toEqual(["Exact"]);

  test.advance(15 * minute);
  await alarm(workspace);
  later = await watching(browser, workspace);
  expect(await settled(later, queued)).toMatchObject({ status: "sent" });
  expect(posts()).toEqual(["Exact", "Queued"]);
});

it("has a post that is due wait its turn behind a delivery to the same account", async () => {
  const held = gate((request) => request === postStatus);
  const context = await ready({ interceptNetwork: held.intercept });
  const { test, workspace, channel, client, posts } = context;
  const { postId, targets } = await schedule(
    client,
    workspace,
    "Scheduled",
    now() + minute,
    channel,
  );
  // Another post is on its way to the account when the time comes: its
  // request to the network is held.
  const other = await writeDraft(client, workspace, "Under way");
  held.close();
  await mutate(
    client,
    client.mutation("target.add", {
      id: newId(),
      postId: other.postId,
      channelId: channel,
    }),
    client.mutation("post.publish", { id: other.postId }),
  );
  await held.reached();

  test.advance(minute);
  await alarm(workspace);

  // The post is due and asked for, and its delivery has not begun: the
  // deliveries to one account go out one after the other.
  await follow(client, () => postOf(client, postId).status === "sending");
  expect(targetOf(client, targets[0] ?? "")).toMatchObject({
    status: "queued",
    attempt: 0,
  });
  expect(posts()).toEqual([]);

  held.open();
  expect(await settled(client, postId)).toMatchObject({ status: "sent" });
  expect(posts()).toEqual(["Under way", "Scheduled"]);
});

it("publishes a post that an alarm finds late, and holds one that it finds more than an hour late", async () => {
  const { test, browser, workspace, channel, client, posts } = await ready();
  const early = await schedule(
    client,
    workspace,
    "Too late",
    now() + minute,
    channel,
  );
  const recent = await schedule(
    client,
    workspace,
    "Late",
    now() + 2 * hour,
    channel,
  );

  // The object could not run for a while: its alarm comes two hours and
  // half an hour after the first post was due, half an hour after the
  // second.
  test.advance(2 * hour + 30 * minute);
  await alarm(workspace);

  const later = await watching(browser, workspace);
  expect(await settled(later, recent.postId)).toMatchObject({
    status: "sent",
  });
  expect(posts()).toEqual(["Late"]);
  // The other is held for the person: scheduled, with the time that it
  // missed, and nothing asked of its target.
  expect(postOf(later, early.postId)).toMatchObject({
    status: "scheduled",
    dueAt: now() - 2 * hour - 29 * minute,
    heldAt: expect.any(Number),
  });
  expect(targetOf(later, early.targets[0] ?? "").status).toBe("pending");
  // A held post is nothing to come back for: the alarm that looked
  // after the delivery comes once more, and sets none after it.
  await alarm(workspace);
  expect(await alarmOf(workspace)).toBeNull();

  // The person sends it after all.
  await mutate(later, later.mutation("post.publish", { id: early.postId }));
  expect(await settled(later, early.postId)).toMatchObject({ status: "sent" });
  expect(posts()).toEqual(["Late", "Too late"]);
});

it("moves a queued post that an alarm finds too late to the next slot", async () => {
  const { test, browser, workspace, channel, client, posts } = await ready();
  await slotsIn(client, 10);
  const queued = await enqueue(client, workspace, "Next week", channel);
  const slot = postOf(client, queued).dueAt ?? 0;

  test.advance(10 * minute + lateMs + minute);
  await alarm(workspace);

  const later = await watching(browser, workspace);
  expect(postOf(later, queued)).toMatchObject({
    status: "scheduled",
    // The same time of the week, a week on.
    dueAt: slot + 7 * 24 * hour,
    heldAt: null,
  });
  expect(posts()).toEqual([]);
});

it("publishes at once a post that a device scheduled for a time that has just passed, and holds one from longer ago", async () => {
  const { workspace, channel, client, posts } = await ready();

  // What a device sends that was without a connection when the times
  // came: no alarm was set for either, and none is waited for.
  const recent = await schedule(
    client,
    workspace,
    "Just missed",
    now() - 10 * minute,
    channel,
  );
  expect(await settled(client, recent.postId)).toMatchObject({
    status: "sent",
  });
  expect(posts()).toEqual(["Just missed"]);

  const old = await schedule(
    client,
    workspace,
    "Long gone",
    now() - 2 * hour,
    channel,
  );
  expect(postOf(client, old.postId)).toMatchObject({
    status: "scheduled",
    heldAt: expect.any(Number),
  });
  expect(posts()).toEqual(["Just missed"]);
});

it("takes up a post that is due before a mutation that would move it, without waiting for the alarm", async () => {
  const { test, workspace, channel, client, posts } = await ready();
  await slotsIn(client, 2, 4);
  const first = await enqueue(client, workspace, "First", channel);

  // The slot has come and the alarm has not run yet when another post is
  // added: the first goes out for its slot, and does not move back.
  test.advance(2 * minute);
  const second = await enqueue(client, workspace, "Second", channel);

  expect(await settled(client, first)).toMatchObject({ status: "sent" });
  expect(posts()).toEqual(["First"]);
  expect(postOf(client, second)).toMatchObject({
    status: "scheduled",
    dueAt: now() + 2 * minute,
  });
});

it("fails a due post on the Sent side when its account needs connecting again", async () => {
  const { test, workspace, channel, client, posts } = await ready();
  const { postId, targets } = await schedule(
    client,
    workspace,
    "Refused",
    now() + minute,
    channel,
  );
  // The network takes the access back before the time comes.
  test.network.mastodon.arm({ kind: "token-revoked", operation: "publish" });

  test.advance(minute);
  await alarm(workspace);

  expect(await settled(client, postId)).toMatchObject({ status: "error" });
  expect(targetOf(client, targets[0] ?? "")).toMatchObject({
    status: "error",
    error: expect.any(String),
  });
  expect(posts()).toEqual([]);
});

it("comes back for a due post that it could not take up, a minute later and not at once", async () => {
  const { test, browser, workspace, channel, client, posts } = await ready();
  const errors = expectErrors();
  const { postId } = await schedule(
    client,
    workspace,
    "Second try",
    now() + minute,
    channel,
  );
  // The database fails when the alarm takes up what is due.
  const taking = vi
    .spyOn(WorkspaceStore.prototype, "publishDue")
    .mockImplementationOnce(() => {
      throw new Error("The database is not there");
    });

  test.advance(minute);
  await alarm(workspace);

  expect(taking).toHaveBeenCalledTimes(1);
  expect(errors).toHaveBeenCalledWith(
    "The posts and deliveries of a workspace were not looked after",
    expect.anything(),
  );
  expect(posts()).toEqual([]);
  // Not at once, which would be a loop for as long as it fails, and not
  // never: in the time that the object gives a delivery.
  const ahead = ((await alarmOf(workspace)) ?? 0) - Date.now();
  expect(ahead).toBeGreaterThan(deliveryWatchMs - 5000);
  expect(ahead).toBeLessThanOrEqual(deliveryWatchMs);

  await alarm(workspace);
  const later = await watching(browser, workspace);
  await vi.waitFor(
    async () => expect((await stored(workspace))[0]?.status).toBe("sent"),
    patience,
  );
  expect(await settled(later, postId)).toMatchObject({ status: "sent" });
  expect(posts()).toEqual(["Second try"]);
});
