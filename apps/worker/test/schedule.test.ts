import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { lateMs, type Row, trashMs } from "@pigy/core";
import { feed, type SimToken } from "@pigy/simulators/world";
import { expect, it, vi } from "vitest";
import { deliveryWatchMs } from "../src/workspace/object.ts";
import { WorkspaceStore } from "../src/workspace/store.ts";
import { device } from "./app-client.ts";
import {
  connectBlueskyLive,
  connectLinkedInLive,
  connectThreadsLive,
} from "./channels.ts";
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

it("publishes a scheduled thread to LinkedIn as the one post that it is there, and to Threads as replies", async () => {
  const { test, browser, workspace } = await ready();
  const linkedin = await connectLinkedInLive(test, browser, workspace);
  const threads = await connectThreadsLive(test, browser, workspace);
  const later = await watching(browser, workspace);
  const { postId } = await writeDraft(later, workspace, "One", "Two");
  await mutate(
    later,
    ...[linkedin, threads].map(({ channel }) =>
      later.mutation("target.add", {
        id: newId(),
        postId,
        channelId: channel ?? "",
      }),
    ),
    later.mutation("post.schedule", { id: postId, dueAt: now() + 2 * minute }),
  );

  test.advance(2 * minute);
  await alarm(workspace);

  // What a post that is published at once makes of a thread on each
  // network, a due post makes too: it goes the same way.
  expect(await settled(later, postId)).toMatchObject({ status: "sent" });
  const texts = (network: "linkedin" | "threads") =>
    feed(test.network.world, [network]).map(({ post }) => post.text);
  expect(texts("linkedin")).toEqual(["One\n\nTwo"]);
  expect(texts("threads")).toEqual(["One", "Two"]);
});

it("fails a due post as a publish fails when the access of its account has ended by its time", async () => {
  const { test, browser, workspace } = await ready();
  const linkedin = await connectLinkedInLive(test, browser, workspace);
  const client = await watching(browser, workspace);
  const { postId, targets } = await schedule(
    client,
    workspace,
    "After the access",
    now() + 2 * minute,
    linkedin.channel ?? "",
  );
  // The token ends before the time comes, as LinkedIn's does after its
  // 60 days. The clock is not moved that far: the post would be held as
  // one that is found too late, and nothing would be asked of LinkedIn.
  const [token] = test.network.world.tokens<SimToken>("linkedin");
  test.network.world.expireToken("linkedin", token?.token ?? "");

  test.advance(2 * minute);
  await alarm(workspace);

  expect(await settled(client, postId)).toMatchObject({ status: "error" });
  expect(targetOf(client, targets[0] ?? "")).toMatchObject({
    status: "error",
    error: expect.stringContaining("60 days"),
  });
  expect(
    client.table("channel").find(({ id }) => id === linkedin.channel)?.status,
  ).toBe("needs_reconnect");
  expect(feed(test.network.world, ["linkedin"])).toEqual([]);
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

it("leaves the look at a delivery under way where it is when a later post is scheduled", async () => {
  const held = gate((request) => request === postStatus);
  const context = await ready({ interceptNetwork: held.intercept });
  const { workspace, channel, client } = context;
  const ahead = async () => ((await alarmOf(workspace)) ?? 0) - Date.now();
  // A post is on its way to the account: its request to the network is
  // held, and the object comes back within a minute to see that the
  // delivery ends.
  const under = await writeDraft(client, workspace, "Under way");
  held.close();
  await mutate(
    client,
    client.mutation("target.add", {
      id: newId(),
      postId: under.postId,
      channelId: channel,
    }),
    client.mutation("post.publish", { id: under.postId }),
  );
  await held.reached();
  // The alarm that began the delivery sets the next one when it is done,
  // which is a moment after the request has gone out.
  await vi.waitFor(async () => expect(await alarmOf(workspace)).not.toBeNull());
  expect(await ahead()).toBeLessThanOrEqual(deliveryWatchMs);
  const look = await alarmOf(workspace);

  // A post for hours from now is nothing to put that look off for, not
  // by the moment either that has passed since: every change of a
  // workspace that is written in would put it off a little more.
  await schedule(client, workspace, "Later", now() + 3 * hour, channel);
  expect(await alarmOf(workspace)).toBe(look);

  held.open();
  expect(await settled(client, under.postId)).toMatchObject({ status: "sent" });
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
    trashedAt: null,
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
    trashedAt: null,
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
    trashedAt: null,
  });
  expect(posts()).toEqual(["Just missed"]);
});

it.each([
  ["one message", true],
  ["two messages", false],
] as const)(
  "publishes a post that is scheduled for a moment ago and taken back in %s",
  async (_, together) => {
    const { workspace, channel, client, posts } = await ready();
    const { postId } = await writeDraft(client, workspace, "A minute ago");
    await mutate(
      client,
      client.mutation("target.add", {
        id: newId(),
        postId,
        channelId: channel,
      }),
    );
    // What becomes of a post does not depend on how a device packs what it
    // sends, which a device that was without a connection decides by how
    // much it has to send: the post is taken up when it is scheduled, and
    // taking it back comes too late either way.
    const scheduling = client.mutation("post.schedule", {
      id: postId,
      dueAt: now() - minute,
    });
    const takingBack = client.mutation("post.unschedule", { id: postId });
    const rejected = [];
    for (const mutations of together
      ? [[scheduling, takingBack]]
      : [[scheduling], [takingBack]]) {
      client.send({ type: "mutate", mutations });
      rejected.push(...(await client.patch()).rejected);
    }

    expect(rejected).toMatchObject([
      { id: takingBack.id, code: "not_scheduled" },
    ]);
    expect(await settled(client, postId)).toMatchObject({ status: "sent" });
    expect(posts()).toEqual(["A minute ago"]);
  },
);

it("sends one post of the queue when an alarm finds several late, and gives the others the slots after it", async () => {
  const { test, browser, workspace, channel, client, posts } = await ready();
  const errors = expectErrors();
  await slotsIn(client, 10, 25, 40, 70, 85);
  const queued = [];
  for (const text of ["One", "Two", "Three"]) {
    queued.push(await enqueue(client, workspace, text, channel));
  }
  const [one = "", two = "", three = ""] = queued;
  const base = now();

  // The alarm comes 50 minutes late, when three slots have passed.
  test.advance(60 * minute);
  await alarm(workspace);

  const later = await watching(browser, workspace);
  expect(await settled(later, one)).toMatchObject({ status: "sent" });
  // Not all three to the same account, one after the other: the two
  // behind the first take the slots that are still to come.
  expect(posts()).toEqual(["One"]);
  const slot = (ahead: number) => {
    // A slot is at a minute of the clock, and `base` may not be.
    const time = base + ahead * minute;
    return time - (time % minute);
  };
  expect(postOf(later, two)).toMatchObject({
    status: "scheduled",
    dueAt: slot(70),
  });
  expect(postOf(later, three)).toMatchObject({
    status: "scheduled",
    dueAt: slot(85),
  });
  // Taking up the first took care of the others: the object did not try
  // to take up posts that were no longer due, which it would log.
  expect(errors).not.toHaveBeenCalled();
});

it("says once that a due post could not be taken up, and leaves it to the alarm", async () => {
  const { test, workspace, channel, client } = await ready();
  const errors = expectErrors();
  const { postId } = await schedule(
    client,
    workspace,
    "Nowhere to go",
    now() + minute,
    channel,
  );
  // What no mutator leaves behind: a scheduled post without an account,
  // which the mutator that takes it up refuses.
  await runInDurableObject(objectOf(workspace), (_, state) => {
    state.storage.sql.exec("delete from post_target");
  });
  test.advance(minute);

  // Two mutations of a client, each of which finds the post due.
  await mutate(
    client,
    client.mutation("post.create", {
      id: newId(),
      partId: newId(),
      text: "One",
    }),
    client.mutation("post.create", {
      id: newId(),
      partId: newId(),
      text: "Two",
    }),
  );

  const said = () =>
    errors.mock.calls.filter(([message]) =>
      String(message).includes("was not taken up"),
    );
  expect(said()).toHaveLength(1);
  // The alarm tries again, and does not say it again.
  await alarm(workspace);
  expect(said()).toHaveLength(1);
  expect(postOf(client, postId).status).toBe("scheduled");
});

it("publishes a post once when its delete and the Undo of that reach the server after its time", async () => {
  const { test, browser, workspace, channel, client, posts } = await ready();
  const app = device(browser, workspace);
  const phone = await app.online();
  const dueAt = now() + 2 * minute;
  const { postId } = await schedule(client, workspace, "Once", dueAt, channel);
  await vi.waitFor(() =>
    expect(phone.store.getView().post.get(postId)?.status).toBe("scheduled"),
  );

  // Two minutes before the time, without a connection: the phone deletes
  // the post, and Undo brings it back. What the app makes of the two:
  // the post is put aside, and that is taken back.
  phone.connection.stop();
  phone.store.mutate("post.trash", { id: postId });
  // The phone shows what it did: the post put aside, which no screen
  // shows, and then scheduled as it was.
  expect(phone.store.getView().post.get(postId)?.trashedAt).not.toBeNull();
  phone.store.mutate("post.restore", { id: postId });
  expect(phone.store.getView().post.get(postId)).toMatchObject({
    status: "scheduled",
    dueAt,
    trashedAt: null,
  });

  // The app is opened again twenty minutes after the time, with a
  // connection, and sends what the phone kept. The server has not heard
  // of the delete, and takes the post up before anything of the phone's:
  // twenty minutes late, which is sent.
  test.advance(22 * minute);
  const back = await app.online();

  const later = await watching(browser, workspace);
  expect(await settled(later, postId)).toMatchObject({ status: "sent" });
  // The delete came too late, and the phone is told. Its Undo found
  // nothing to take back, and made no post: the post went out once.
  expect(
    back.store.getRejections().map(({ name, code }) => [name, code]),
  ).toEqual([["post.trash", "not_scheduled"]]);
  expect((await stored(workspace)).map(({ id }) => id)).toEqual([postId]);
  expect(posts()).toEqual(["Once"]);
});

it("publishes a post once when it went out and its record was deleted before the delete and the Undo of a phone arrive", async () => {
  const { test, browser, workspace, channel, client, posts } = await ready();
  const app = device(browser, workspace);
  const phone = await app.online();
  const dueAt = now() + 2 * minute;
  const { postId } = await schedule(client, workspace, "Once", dueAt, channel);
  await vi.waitFor(() =>
    expect(phone.store.getView().post.get(postId)?.status).toBe("scheduled"),
  );
  // Without a connection, the phone deletes the post, takes that back,
  // and has let the notice of a second deletion pass before: everything
  // that the Queue screen can make of a post.
  phone.connection.stop();
  phone.store.mutate("post.trash", { id: postId });
  phone.store.mutate("post.restore", { id: postId });

  // The server publishes the post at its time, and another device
  // deletes its record from the Sent screen: the post stays on the
  // network, and the workspace knows nothing of it any more.
  test.advance(2 * minute);
  await alarm(workspace);
  const other = await watching(browser, workspace);
  expect(await settled(other, postId)).toMatchObject({ status: "sent" });
  await mutate(other, other.mutation("post.delete", { id: postId }));

  // The phone is back twenty minutes later. Nothing is there for what it
  // kept to be about. An Undo that scheduled a copy of the post would
  // find the original gone, as if its own delete had deleted it, and
  // publish the copy: twenty minutes late, which is sent.
  test.advance(20 * minute);
  const back = await app.online();

  expect(back.store.getRejections()).toEqual([]);
  // No post is left that could go out, and nothing more is on the
  // network than the one.
  expect(await stored(workspace)).toEqual([]);
  expect(posts()).toEqual(["Once"]);
});

it("does not publish a post that was put aside when its time comes, and deletes it a day later for a device that never did", async () => {
  const { test, browser, workspace, channel, client, posts } = await ready();
  const dueAt = now() + 2 * minute;
  const { postId } = await schedule(client, workspace, "Aside", dueAt, channel);

  // The window is closed while the Undo is still offered: the second
  // step of the deletion never comes.
  await mutate(client, client.mutation("post.trash", { id: postId }));

  // Its time comes and goes. The alarm that was set for it, which a
  // change never puts off, finds nothing due.
  test.advance(3 * minute);
  await alarm(workspace);
  expect(await stored(workspace)).toMatchObject([
    { id: postId, status: "scheduled" },
  ]);
  expect(posts()).toEqual([]);
  // The next one is for the deletion: a day after the post was put
  // aside, which was three minutes ago.
  const set = (await alarmOf(workspace)) ?? 0;
  expect(set - Date.now()).toBeGreaterThan(trashMs - 4 * minute);
  expect(set - Date.now()).toBeLessThanOrEqual(trashMs - 3 * minute);

  // Then the alarm deletes it, with its part and its target, and a
  // client hears of it like of any change. A whole day on, and so past
  // the time: every mutation of a workspace has a time of its own, a
  // millisecond after the one before.
  test.advance(trashMs);
  const later = await watching(browser, workspace);
  expect(later.copy.post.map(({ id }) => id)).toEqual([postId]);
  await alarm(workspace);
  await follow(later, () => later.copy.post.length === 0);
  expect(later.copy.post_part).toEqual([]);
  expect(later.copy.post_target).toEqual([]);
  expect(await stored(workspace)).toEqual([]);
  expect(posts()).toEqual([]);
  // Nothing is left for the object to do by itself.
  expect(await alarmOf(workspace)).toBeNull();
});

it("stores the time zone of a workspace under the name that the server has for it", async () => {
  const { client } = await ready();

  await mutate(
    client,
    client.mutation("settings.setTimeZone", { timeZone: "europe/ROME" }),
  );

  // In the runtime that the server is: the mutator asks it for the name.
  expect(client.copy.settings).toMatchObject([{ timeZone: "Europe/Rome" }]);
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
    "The scheduled posts of a workspace were not taken up",
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
