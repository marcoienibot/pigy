import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  maxPublishRecordDeliveries,
  type PublishRecordResponse,
  publishRecordLifetimeMs,
  publishRecordPageSize,
  publishRecordResponseSchema,
} from "@pigy/core";
import { expect, it, vi } from "vitest";
import { apiClient, makeKey, startedApi } from "./api.ts";
import { disconnected } from "./channels.ts";
import {
  type Browser,
  invite,
  realMastodonDomain,
  signedIn,
} from "./helpers.ts";
import {
  connectAccount,
  ended,
  gate,
  inPlaceOfPosting,
  patience,
  postStatus,
  publishTo,
  retry,
  started,
  targetOf,
  writeDraft,
} from "./publishing.ts";
import { newId, objectOf, SyncClient } from "./sync-client.ts";

/**
 * The record of what a workspace was asked to publish, which its object
 * keeps where no client syncs it: `recordPublishing` of
 * src/workspace/store.ts, and the route that the Settings of the app read
 * it with.
 */

const day = 24 * 60 * 60 * 1000;

/** The record of a workspace as its owner reads it. */
async function recordOf(
  browser: Browser,
  workspaceId: string,
  before?: number,
): Promise<PublishRecordResponse> {
  const query = before === undefined ? "" : `?before=${before}`;
  const response = await browser.fetch(
    `/api/workspaces/${workspaceId}/publish-record${query}`,
  );
  expect(response.status).toBe(200);
  return publishRecordResponseSchema.parse(await response.json());
}

/** Writes rows into the record of a workspace, as old ones would be. */
const recorded = (
  workspaceId: string,
  rows: { postId: string; requestedAt: number; targets: number }[],
) =>
  runInDurableObject(objectOf(workspaceId), (_, state) => {
    for (const { postId, requestedAt, targets } of rows) {
      for (let index = 0; index < targets; index += 1) {
        state.storage.sql.exec(
          `insert into publish_record
             (post_id, requested_at, source, target_id, channel_id, network, outcome, ended_at)
           values (?, ?, 'app', ?, 'channel', 'mastodon', 'sent', ?)`,
          postId,
          requestedAt,
          `${postId}-${index}`,
          requestedAt,
        );
      }
    }
  });

/** How many deliveries the record of a workspace holds. */
const deliveriesIn = (workspaceId: string) =>
  runInDurableObject(objectOf(workspaceId), (_, state) =>
    state.storage.sql
      .exec<{ n: number }>("select count(*) as n from publish_record")
      .one(),
  ).then(({ n }) => n);

it("records a post that the app publishes, how each delivery ended, and a delivery that is tried again, without the text", async () => {
  // Mastodon refuses the first request to post, for good: a 422 is a
  // status that the network will not take. And the requests wait at a
  // gate while the test reads the record of deliveries that have not
  // ended: a refusal of the simulated network is quicker than a read.
  let refuse = true;
  const held = gate((request) => request === postStatus);
  const refusing = inPlaceOfPosting(
    () => refuse,
    async () => {
      refuse = false;
      return Response.json(
        { error: "Validation failed: Text is not allowed" },
        { status: 422 },
      );
    },
  );
  const { test, browser, workspaces } = await started({
    interceptNetwork: (network) => held.intercept(refusing(network)),
  });
  const workspace = workspaces.live;
  const first = await connectAccount(test, browser, workspace);
  const second = await connectAccount(test, browser, workspace, {
    domain: realMastodonDomain,
    accountId: test.network.mastodon.addAccount(
      realMastodonDomain,
      "ada",
      "Ada Lovelace",
    ).id,
  });
  const client = new SyncClient();
  await client.connect(browser, workspace);
  const text = "A text that the record does not keep";
  const draft = await writeDraft(client, workspace, text);
  const publishedAt = test.clock.time.getTime();

  held.close();
  const targetIds = await publishTo(client, draft.postId, first, second);
  await held.reached();
  // While the deliveries are on their way the request is there, and says
  // that they have not ended.
  const sending = await recordOf(browser, workspace);
  expect(sending.requests).toHaveLength(1);
  expect(sending.requests[0]?.deliveries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ channelId: first, outcome: null }),
      expect.objectContaining({ channelId: second, outcome: null }),
    ]),
  );
  held.open();
  await ended(client, draft.postId);

  const record = await recordOf(browser, workspace);
  expect(record).toEqual({
    more: false,
    requests: [
      {
        postId: draft.postId,
        // The time of the mutation, which is the clock's or a moment
        // after the mutation before it.
        requestedAt: expect.any(Number),
        source: "app",
        apiKeyId: null,
        deliveries: expect.arrayContaining(
          targetIds.map((targetId, index) => ({
            targetId,
            channelId: [first, second][index],
            network: "mastodon",
            outcome: targetOf(client, targetId).status,
            endedAt: expect.any(Number),
          })),
        ),
      },
    ],
  });
  expect(record.requests[0]?.requestedAt).toBeGreaterThanOrEqual(publishedAt);
  // One was refused, the other was sent: each is recorded as it ended.
  expect(
    record.requests[0]?.deliveries.map(({ outcome }) => outcome).sort(),
  ).toEqual(["error", "sent"]);

  // The person tries the one that failed again: another request, for that
  // account alone.
  const failed = targetIds.find(
    (targetId) => targetOf(client, targetId).status === "error",
  );
  if (!failed) throw new Error("No delivery failed");
  await retry(client, failed);
  await ended(client, draft.postId);
  const after = await recordOf(browser, workspace);
  expect(after.requests).toHaveLength(2);
  expect(after.requests[0]).toMatchObject({
    source: "app",
    deliveries: [{ targetId: failed, outcome: "sent" }],
  });
  // The request before keeps the outcome that it had.
  expect(after.requests[1]).toEqual(record.requests[0]);

  // A post is named by its ID: the record says nothing that it says.
  const stored = await runInDurableObject(objectOf(workspace), (_, state) =>
    JSON.stringify(
      state.storage.sql.exec("select * from publish_record").toArray(),
    ),
  );
  expect(stored).not.toContain(text);
  expect(JSON.stringify(after)).not.toContain(text);
});

it("records a scheduled post as asked for by the schedule, when it is due", async () => {
  const { test, browser, workspaces } = await started();
  const workspace = workspaces.live;
  const channelId = await connectAccount(test, browser, workspace);
  const client = new SyncClient();
  await client.connect(browser, workspace);
  const draft = await writeDraft(client, workspace, "Later");
  client.send({
    type: "mutate",
    mutations: [
      client.mutation("target.add", {
        id: newId(),
        postId: draft.postId,
        channelId,
      }),
      client.mutation("post.schedule", {
        id: draft.postId,
        dueAt: test.clock.time.getTime() + day,
      }),
    ],
  });
  expect((await client.patch()).rejected).toEqual([]);
  // Scheduling is no request to publish yet.
  expect((await recordOf(browser, workspace)).requests).toEqual([]);

  test.advance(day);
  expect(await runDurableObjectAlarm(objectOf(workspace))).toBe(true);

  // The socket of the client has ended with the day that passed: the
  // record is asked until the delivery has ended.
  await vi.waitFor(async () => {
    expect((await recordOf(browser, workspace)).requests).toMatchObject([
      {
        postId: draft.postId,
        source: "schedule",
        apiKeyId: null,
        deliveries: [{ channelId, outcome: "sent" }],
      },
    ]);
  }, patience);
});

it("records a post of the queue as asked for by the queue, when its slot has come", async () => {
  const { test, browser, workspaces } = await started();
  const workspace = workspaces.live;
  const channelId = await connectAccount(test, browser, workspace);
  const client = new SyncClient();
  await client.connect(browser, workspace);
  const draft = await writeDraft(client, workspace, "In the queue");
  // A slot in a minute, on the clocks of UTC, which is the time zone of a
  // workspace that has set none.
  const slot = new Date(test.clock.time.getTime() + 60 * 1000);
  client.send({
    type: "mutate",
    mutations: [
      client.mutation("slot.add", {
        id: newId(),
        weekday: slot.getUTCDay(),
        minute: slot.getUTCHours() * 60 + slot.getUTCMinutes(),
      }),
      client.mutation("target.add", {
        id: newId(),
        postId: draft.postId,
        channelId,
      }),
      client.mutation("post.enqueue", { id: draft.postId, first: false }),
    ],
  });
  expect((await client.patch()).rejected).toEqual([]);

  test.advance(2 * 60 * 1000);
  expect(await runDurableObjectAlarm(objectOf(workspace))).toBe(true);

  await vi.waitFor(async () => {
    expect((await recordOf(browser, workspace)).requests).toMatchObject([
      {
        postId: draft.postId,
        source: "queue",
        apiKeyId: null,
        deliveries: [{ channelId, outcome: "sent" }],
      },
    ]);
  }, patience);
});

it("records a post that is scheduled or brought back for a time that has passed, which goes out at once, as whoever did that", async () => {
  const { test, browser, workspaces } = await startedApi();
  const workspace = workspaces.live;
  const channelId = await connectAccount(test, browser, workspace);
  const { apiKey, secret } = await makeKey(browser, workspace);
  const api = apiClient(test, secret);
  const minuteAgo = () => test.clock.time.getTime() - 60 * 1000;

  // A key schedules a post for a minute ago: it goes out at once. The key
  // asked for that, and no schedule did.
  const late = await api.create({
    text: "Late",
    channelIds: [channelId],
    mode: "customScheduled",
    dueAt: new Date(minuteAgo()).toISOString(),
  });
  await api.ended(late.id);

  // The app does the same, and brings back a post that was put aside
  // while its time passed.
  const client = new SyncClient();
  await client.connect(browser, workspace);
  const scheduled = await writeDraft(client, workspace, "Scheduled late");
  const restored = await writeDraft(client, workspace, "Brought back");
  client.send({
    type: "mutate",
    mutations: [
      client.mutation("target.add", {
        id: newId(),
        postId: scheduled.postId,
        channelId,
      }),
      client.mutation("post.schedule", {
        id: scheduled.postId,
        dueAt: minuteAgo(),
      }),
      client.mutation("target.add", {
        id: newId(),
        postId: restored.postId,
        channelId,
      }),
      client.mutation("post.schedule", {
        id: restored.postId,
        dueAt: test.clock.time.getTime() + 60 * 1000,
      }),
      client.mutation("post.trash", { id: restored.postId }),
    ],
  });
  expect((await client.patch()).rejected).toEqual([]);
  test.advance(2 * 60 * 1000);
  client.mutate("post.restore", { id: restored.postId });
  expect((await client.patch()).rejected).toEqual([]);
  await ended(client, scheduled.postId);
  await ended(client, restored.postId);

  const sources = Object.fromEntries(
    (await recordOf(browser, workspace)).requests.map(
      ({ postId, source, apiKeyId }) => [postId, { source, apiKeyId }],
    ),
  );
  expect(sources).toEqual({
    [late.id]: { source: "api", apiKeyId: apiKey.id },
    [scheduled.postId]: { source: "app", apiKeyId: null },
    [restored.postId]: { source: "app", apiKeyId: null },
  });
});

it("records a post of the public API with the ID of its key, and never the key", async () => {
  const { test, browser, workspaces } = await startedApi();
  const workspace = workspaces.live;
  const channelId = await connectAccount(test, browser, workspace);
  const { apiKey, secret } = await makeKey(browser, workspace);
  const api = apiClient(test, secret);

  const post = await api.create({
    text: "From a script",
    channelIds: [channelId],
    mode: "shareNow",
  });
  await api.ended(post.id);

  const record = await recordOf(browser, workspace);
  expect(record.requests).toMatchObject([
    {
      postId: post.id,
      source: "api",
      apiKeyId: apiKey.id,
      deliveries: [{ channelId, outcome: "sent" }],
    },
  ]);
  expect(JSON.stringify(record)).not.toContain(secret);
  // A draft of the API is no request to publish.
  await api.create({ text: "A draft", saveToDraft: true });
  expect((await recordOf(browser, workspace)).requests).toHaveLength(1);
});

it("records a delivery that a disconnect ended as such", async () => {
  const held = gate((request) => request === postStatus);
  const { test, browser, workspaces } = await started({
    interceptNetwork: held.intercept,
  });
  const workspace = workspaces.live;
  const channelId = await connectAccount(test, browser, workspace);
  const client = new SyncClient();
  await client.connect(browser, workspace);
  const draft = await writeDraft(client, workspace, "Gone");
  held.close();
  await publishTo(client, draft.postId, channelId);
  await held.reached();

  await disconnected(browser, workspace, channelId);
  held.open();

  expect((await recordOf(browser, workspace)).requests).toMatchObject([
    { deliveries: [{ channelId, outcome: "disconnected" }] },
  ]);
});

it("keeps what it records to 90 days and a number of deliveries, a request whole, and hands it out in pages", async () => {
  const { test, browser, workspaces } = await started();
  const workspace = workspaces.live;
  const now = test.clock.time.getTime();
  // More requests than a page holds, of two deliveries each, and one that
  // is older than the record keeps.
  const requests = publishRecordPageSize + 10;
  await recorded(workspace, [
    {
      postId: "old",
      requestedAt: now - publishRecordLifetimeMs - 1,
      targets: 1,
    },
    ...Array.from({ length: requests }, (_, index) => ({
      postId: `post-${index}`,
      requestedAt: now - requests + index,
      targets: 2,
    })),
  ]);

  const first = await recordOf(browser, workspace);
  expect(first.requests).toHaveLength(publishRecordPageSize);
  expect(first.more).toBe(true);
  // The newest first, each with its deliveries.
  expect(first.requests[0]).toMatchObject({
    postId: `post-${requests - 1}`,
    deliveries: [{}, {}],
  });
  const last = first.requests.at(-1);
  const rest = await recordOf(browser, workspace, last?.requestedAt);
  expect(rest.requests).toHaveLength(requests - publishRecordPageSize);
  expect(rest.more).toBe(false);
  // The one that is too old is not handed out, though it is still there.
  expect(rest.requests.map(({ postId }) => postId)).not.toContain("old");
  expect(await deliveriesIn(workspace)).toBe(2 * requests + 1);

  // Fill the record to its bound, and publish once more.
  await recorded(
    workspace,
    Array.from(
      { length: maxPublishRecordDeliveries / 2 - requests },
      (_, index) => ({
        postId: `more-${index}`,
        requestedAt: now - day + index,
        targets: 2,
      }),
    ),
  );
  const channelId = await connectAccount(test, browser, workspace);
  const client = new SyncClient();
  await client.connect(browser, workspace);
  const draft = await writeDraft(client, workspace, "One more");
  await publishTo(client, draft.postId, channelId);
  await ended(client, draft.postId);

  // The old one went with it, and as many of the oldest as the bound
  // takes: whole requests, of two deliveries each.
  const kept = await deliveriesIn(workspace);
  expect(kept).toBeLessThanOrEqual(maxPublishRecordDeliveries);
  expect(kept % 2).toBe(1);
  const ids = await runInDurableObject(objectOf(workspace), (_, state) =>
    state.storage.sql
      .exec<{ post_id: string }>("select distinct post_id from publish_record")
      .toArray()
      .map(({ post_id }) => post_id),
  );
  expect(ids).not.toContain("old");
  expect(ids).toContain(draft.postId);
});

it("is the owner's alone", async () => {
  const { test, browser, workspaces } = await started();
  await invite(test, "member@example.com");
  const member = await signedIn(test, { email: "member@example.com" });
  const path = `/api/workspaces/${workspaces.live}/publish-record`;

  // Somebody else, and nobody.
  expect((await member.fetch(path)).status).toBe(404);
  expect((await test.browser().fetch(path)).status).toBe(401);
  // A question that is not one.
  expect((await browser.fetch(`${path}?before=soon`)).status).toBe(400);
  expect((await browser.fetch(`${path}?after=1`)).status).toBe(400);
});
