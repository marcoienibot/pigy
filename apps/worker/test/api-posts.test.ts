import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type Environment,
  maxSlots,
  requeues,
  type SandboxPost,
  sandboxFeedSchema,
  sandboxLink,
  sandboxMastodonDomain,
} from "@pigy/core";
import {
  apiChannelListSchema,
  apiChannelSchema,
  apiPostingScheduleSchema,
  apiPostListSchema,
} from "@pigy/core/api";
import { feed } from "@pigy/simulators/world";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { describe, expect, it } from "vitest";
import { postsPage } from "../src/workspace/api.ts";
import { farthestLookMs } from "../src/workspace/object.ts";
import { type ApiClient, apiClient, makeKey, startedApi } from "./api.ts";
import { connectInSandbox, connectLinkedInInSandbox } from "./channels.ts";
import { type Browser, realMastodonDomain, type TestSetup } from "./helpers.ts";
import { connectAccount, gate, postStatus } from "./publishing.ts";
import { identityOf, objectOf, SyncClient } from "./sync-client.ts";

/**
 * What the public API does with posts, channels and the posting schedule,
 * with a key of a live workspace and with one of a sandbox. The live
 * workspace posts to what stands for the real networks, `test.network`,
 * and the sandbox to its simulated world.
 */

const minute = 60 * 1000;
const hour = 60 * minute;

/** A workspace with a Mastodon account connected, and a key for it. */
async function ready(
  environment: Environment = "live",
  options: Parameters<typeof startedApi>[0] = {},
) {
  const context = await startedApi(options);
  const { test, browser, workspaces } = context;
  const workspace = workspaces[environment];
  const channel = await connect(test, browser, environment, workspace);
  const { secret } = await makeKey(browser, workspace);
  const api = apiClient(test, secret);
  return { ...context, workspace, channel, api, secret };
}

async function connect(
  test: TestSetup,
  browser: Browser,
  environment: Environment,
  workspace: string,
): Promise<string> {
  if (environment === "live") return connectAccount(test, browser, workspace);
  const { channel } = await connectInSandbox(browser, workspace);
  if (!channel) throw new Error("The connection names no channel");
  return channel;
}

/**
 * The texts that are on the network of `environment`, in the order they
 * were posted, each part of a thread by itself.
 */
async function published(
  { test, browser }: { test: TestSetup; browser: Browser },
  environment: Environment,
): Promise<string[]> {
  if (environment === "live") {
    return feed(test.network.world).map(({ post }) => post.text);
  }
  // With the marks, as the app asks: the shape of the feed has them.
  const response = await browser.fetch("/api/sandbox/feed?marks=1");
  const { accounts } = sandboxFeedSchema.parse(await response.json());
  const flat = (post: SandboxPost): SandboxPost[] => [
    post,
    ...post.replies.flatMap(flat),
  ];
  return accounts
    .flatMap(({ posts }) => posts.flatMap(flat))
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    .map(({ text }) => text);
}

/** Runs the alarm of the workspace, which has to be set. */
async function alarm(workspace: string) {
  expect(await runDurableObjectAlarm(objectOf(workspace))).toBe(true);
}

const channelsOf = async (api: ApiClient) =>
  apiChannelListSchema.parse(await api.ok("/channels")).channels;

const listOf = async (api: ApiClient, query = "") =>
  apiPostListSchema.parse(await api.ok(`/posts${query}`));

const scheduleOf = async (api: ApiClient) =>
  apiPostingScheduleSchema.parse(await api.ok("/posting-schedule"));

/** Gives the workspace posting times on the clocks of UTC. */
const setTimes = async (
  api: ApiClient,
  schedule: { day: string; times: string[] }[],
) =>
  apiPostingScheduleSchema.parse(
    await api.ok("/posting-schedule", {
      method: "PUT",
      json: { timeZone: "UTC", schedule },
    }),
  );

describe.each(["live", "sandbox"] as const)(
  "with a key of a %s workspace",
  (environment) => {
    const domain =
      environment === "live" ? realMastodonDomain : sandboxMastodonDomain;

    it("says whose key it is, and lists the channels of its workspace", async () => {
      const context = await ready(environment);
      const { api, workspace, channel, test } = context;

      expect(await api.ok("/account")).toEqual({
        id: expect.any(String),
        email: "admin@example.com",
        name: expect.any(String),
        workspace: { id: workspace, environment },
        apiKey: {
          id: expect.stringMatching(/^[0-9a-f]{16}$/),
          name: "A script",
          scopes: ["posts:read", "posts:write", "channels:read"],
          expiresAt: null,
        },
      });

      const [listed, ...others] = await channelsOf(api);
      expect(others).toEqual([]);
      expect(listed).toMatchObject({
        id: channel,
        service: "mastodon",
        handle: expect.stringContaining(domain),
        status: "connected",
        connectedAt: test.clock.time.toISOString(),
        limits: { maxCharacters: expect.any(Number) },
      });
      expect(
        apiChannelSchema.parse(await api.ok(`/channels/${channel}`)),
      ).toEqual(listed);
      // Nothing of the access to the account is in what a key reads.
      expect(Object.keys(listed ?? {}).sort()).toEqual([
        "avatarUrl",
        "connectedAt",
        "expiresAt",
        "handle",
        "id",
        "limits",
        "name",
        "profileUrl",
        "service",
        "serviceId",
        "status",
      ]);
    });

    it("shares a post now, on the network of its environment and on no other", async () => {
      const context = await ready(environment);
      const { api, channel, test } = context;
      const before = test.network.requests.length;

      const post = await api.create({
        text: "Shared now",
        channelIds: [channel],
        mode: "shareNow",
      });
      expect(post).toMatchObject({
        status: "sending",
        text: "Shared now",
        mode: "shareNow",
        dueAt: null,
        channelIds: [channel],
        targets: [
          { channelId: channel, service: "mastodon", status: "queued" },
        ],
      });

      const sent = await api.ended(post.id);
      expect(sent.status).toBe("sent");
      expect(sent.targets).toEqual([
        {
          channelId: channel,
          service: "mastodon",
          status: "sent",
          // It got the text of the post, which the post says.
          text: null,
          thread: null,
          customized: false,
          textOmitted: false,
          // A simulated network of a sandbox has no page to link to.
          link: environment === "live" ? expect.stringContaining(domain) : null,
          remoteId: expect.any(String),
          error: null,
          disconnected: false,
          sentAt: expect.any(String),
          metrics: null,
        },
      ]);
      expect(await published(context, environment)).toEqual(["Shared now"]);
      // A key of the sandbox sends nothing to what stands for the internet.
      const requests = test.network.requests.length - before;
      if (environment === "sandbox") expect(requests).toBe(0);
      else expect(requests).toBeGreaterThan(0);
    });

    it("schedules a post, which goes out when its time has come", async () => {
      const context = await ready(environment);
      const { api, channel, test, workspace } = context;
      const dueAt = new Date(test.clock.time.getTime() + 2 * hour);

      const post = await api.create({
        text: "In two hours",
        channelIds: [channel],
        mode: "customScheduled",
        // With an offset, as a script may write it: the answer is in UTC.
        dueAt: dueAt.toISOString().replace("Z", "+00:00"),
      });
      expect(post).toMatchObject({
        status: "scheduled",
        mode: "customScheduled",
        dueAt: dueAt.toISOString(),
        targets: [{ status: "pending" }],
      });

      // Not before its time.
      test.advance(2 * hour - minute);
      await alarm(workspace);
      expect((await api.post(post.id)).status).toBe("scheduled");
      expect(await published(context, environment)).toEqual([]);

      test.advance(minute);
      await alarm(workspace);
      const sent = await api.ended(post.id);
      expect(sent).toMatchObject({
        status: "sent",
        mode: "customScheduled",
        dueAt: dueAt.toISOString(),
      });
      expect(await published(context, environment)).toEqual(["In two hours"]);
    });

    it("publishes a thread, and a text of its own to the channels of one service", async () => {
      const context = await ready(environment);
      const { api, channel } = context;

      const thread = await api.create({
        text: "One",
        channelIds: [channel],
        mode: "shareNow",
        metadata: { thread: [{ text: "Two" }, { text: "Three" }] },
      });
      expect(thread.metadata).toEqual({
        thread: [{ text: "Two" }, { text: "Three" }],
      });
      expect((await api.ended(thread.id)).status).toBe("sent");
      expect(await published(context, environment)).toEqual([
        "One",
        "Two",
        "Three",
      ]);

      const own = await api.create({
        text: "For everybody",
        channelIds: [channel],
        mode: "shareNow",
        metadata: {
          thread: [{ text: "And more for everybody" }],
          mastodon: { text: "For Mastodon", thread: [{ text: "Only there" }] },
        },
      });
      // The post keeps its own text, and says what the channel gets.
      expect(own).toMatchObject({
        text: "For everybody",
        metadata: { thread: [{ text: "And more for everybody" }] },
        targets: [
          {
            customized: true,
            textOmitted: false,
            text: "For Mastodon",
            thread: [{ text: "Only there" }],
          },
        ],
      });
      expect((await api.ended(own.id)).status).toBe("sent");
      expect((await published(context, environment)).slice(3)).toEqual([
        "For Mastodon",
        "Only there",
      ]);
    });
  },
);

it("publishes a post of the API with the card of its link, as a post of the app", async () => {
  const { test, browser, workspaces } = await startedApi();
  const workspace = workspaces.sandbox;
  // LinkedIn reads no page for a post of an application: a card on a post
  // there is one that the publishing workflow read, in its step for
  // that, which a post of the API goes through like every other.
  const { channel } = await connectLinkedInInSandbox(browser, workspace);
  const api = apiClient(test, (await makeKey(browser, workspace)).secret);
  const text = `Read this: ${sandboxLink}`;

  const post = await api.create({
    text,
    channelIds: [channel],
    mode: "shareNow",
  });
  expect((await api.ended(post.id)).status).toBe("sent");

  const response = await browser.fetch("/api/sandbox/feed?marks=1");
  const { accounts } = sandboxFeedSchema.parse(await response.json());
  expect(
    accounts
      .flatMap(({ posts }) => posts)
      .map((shown) => ({ text: shown.text, card: shown.card?.title ?? null })),
  ).toEqual([{ text, card: "The example page" }]);
  // The page is one of the simulated web of the sandbox: nothing left
  // the Worker for it.
  expect(test.network.requests).toEqual([]);
});

it("keeps as a draft what it would not publish, and says what keeps a post from going out", async () => {
  const { api, channel, test, browser, workspace } = await ready();
  const [{ limits } = { limits: null }] = await channelsOf(api);
  if (!limits) throw new Error("The channel has no limits");
  const tooLong = "x".repeat(limits.maxCharacters + 1);

  // A draft may hold anything: no channel, no text, a text that is too
  // long. Its mode says nothing.
  const empty = await api.create({ text: "", saveToDraft: true });
  expect(empty).toMatchObject({
    status: "draft",
    mode: null,
    channelIds: [],
    targets: [],
  });
  const long = await api.create({
    text: tooLong,
    channelIds: [channel],
    saveToDraft: true,
    mode: "shareNow",
  });
  expect(long).toMatchObject({
    status: "draft",
    targets: [{ status: "pending" }],
  });

  // What goes out is held to what the editor of the app would publish.
  const client = new SyncClient();
  await client.connect(browser, workspace);
  const before = client.table("post").length;
  const share = (json: object) =>
    api.refused(
      "/posts",
      { method: "POST", json: { mode: "shareNow", ...json } },
      400,
    );
  expect(await share({ text: "Nowhere" })).toMatchObject({
    error: "InvalidInputError",
    field: "channelIds",
  });
  expect(await share({ text: "Nowhere", channelIds: [] })).toMatchObject({
    field: "channelIds",
  });
  expect(await share({ text: "  ", channelIds: [channel] })).toMatchObject({
    field: "text",
    message: expect.stringContaining("no text"),
  });
  expect(await share({ text: tooLong, channelIds: [channel] })).toMatchObject({
    field: "text",
    message: expect.stringContaining(String(limits.maxCharacters)),
  });
  expect(
    await share({
      text: "Fine",
      channelIds: [channel],
      metadata: { thread: [{ text: "Fine" }, { text: tooLong }] },
    }),
  ).toMatchObject({ field: "metadata.thread.1.text" });
  expect(
    await share({
      text: "Fine",
      channelIds: [channel],
      metadata: { mastodon: { thread: [{ text: "" }] } },
    }),
  ).toMatchObject({ field: "metadata.mastodon.thread.0.text" });
  // A text for a service that the post does not go to.
  expect(
    await share({
      text: "Fine",
      channelIds: [channel],
      metadata: { bluesky: { text: "For nobody" } },
    }),
  ).toMatchObject({ field: "metadata.bluesky" });
  expect(
    await share({
      text: "Fine",
      channelIds: ["01939c2e-0000-7000-8000-000000000000"],
    }),
  ).toMatchObject({ field: "channelIds" });
  // The same for a time and for the queue.
  await api.refused(
    "/posts",
    {
      method: "POST",
      json: { text: tooLong, channelIds: [channel], mode: "addToQueue" },
    },
    400,
  );

  // A call is all or nothing: the refused ones made a post, parts and
  // targets before they were refused, and left none of them. A client of
  // the app that was connected all along has heard of nothing.
  expect((await listOf(api)).posts.map(({ id }) => id).sort()).toEqual(
    [empty.id, long.id].sort(),
  );
  const again = new SyncClient();
  await again.connect(browser, workspace);
  expect(again.table("post")).toHaveLength(before);
  expect(again.table("post_part")).toHaveLength(before);
  expect(again.table("post_target")).toHaveLength(1);

  // An account that has to be connected again takes nothing.
  const [listed] = await channelsOf(api);
  await env.WORKSPACE.getByName(workspace).mutate(
    await identityOf(test, workspace),
    "channel.lapse",
    { id: channel, connectedAt: Date.parse(listed?.connectedAt ?? "") },
  );
  expect((await channelsOf(api))[0]?.status).toBe("needs_reconnect");
  expect(await share({ text: "Fine", channelIds: [channel] })).toMatchObject({
    field: "channelIds",
    message: expect.stringContaining("connected again"),
  });
});

it("refuses a request that says how to share a post in a way that makes no sense", async () => {
  const { api, channel, test } = await ready();
  const dueAt = new Date(test.clock.time.getTime() + hour).toISOString();
  const create = (json: object) =>
    api.refused("/posts", { method: "POST", json }, 400);

  expect(await create({ text: "Hello", channelIds: [channel] })).toMatchObject({
    field: "mode",
  });
  expect(
    await create({
      text: "Hello",
      channelIds: [channel],
      mode: "customScheduled",
    }),
  ).toMatchObject({ field: "dueAt" });
  expect(
    await create({
      text: "Hello",
      channelIds: [channel],
      mode: "shareNow",
      dueAt,
    }),
  ).toMatchObject({ field: "dueAt" });
  expect(
    await create({ text: "Hello", channelIds: [channel], mode: "later" }),
  ).toMatchObject({ field: "mode" });
  expect(
    await create({
      text: "Hello",
      channelIds: [channel],
      mode: "customScheduled",
      dueAt: "tomorrow",
    }),
  ).toMatchObject({ field: "dueAt" });
  expect(
    await create({
      text: "Hello",
      channelIds: [channel, channel],
      saveToDraft: true,
    }),
  ).toMatchObject({ field: "channelIds" });
  // A field that the route does not have is refused, not passed over.
  expect(
    await create({
      text: "Hello",
      saveToDraft: true,
      schedulingType: "automatic",
    }),
  ).toMatchObject({ error: "InvalidInputError" });
  // Images are not there yet, in a post and by themselves.
  expect(
    await create({
      text: "Hello",
      saveToDraft: true,
      assets: [{ url: "https://example.com/cat.png", altText: "A cat" }],
    }),
  ).toMatchObject({ field: "assets" });
  expect(
    await api.refused("/media", { method: "POST", json: {} }, 501),
  ).toMatchObject({
    error: "UnexpectedError",
    message: expect.stringContaining("not available yet"),
  });
  expect((await listOf(api)).posts).toEqual([]);
});

it("changes a draft: its text, its thread, its channels and the text of a service", async () => {
  const { api, channel } = await ready();
  const draft = await api.create({
    text: "One",
    saveToDraft: true,
    metadata: { thread: [{ text: "Two" }, { text: "Three" }] },
  });
  const patch = async (json: object) =>
    api.ok(`/posts/${draft.id}`, { method: "PATCH", json });

  expect(await patch({ text: "First" })).toMatchObject({
    status: "draft",
    text: "First",
    metadata: { thread: [{ text: "Two" }, { text: "Three" }] },
  });
  // The thread is replaced as a whole: shorter, then longer.
  expect(
    await patch({ metadata: { thread: [{ text: "Second" }] } }),
  ).toMatchObject({
    text: "First",
    metadata: { thread: [{ text: "Second" }] },
  });
  expect(
    await patch({
      metadata: { thread: [{ text: "Second" }, { text: "3" }, { text: "4" }] },
    }),
  ).toMatchObject({
    metadata: { thread: [{ text: "Second" }, { text: "3" }, { text: "4" }] },
  });
  expect(await patch({ metadata: { thread: [] } })).toMatchObject({
    metadata: { thread: [] },
  });

  expect(await patch({ channelIds: [channel] })).toMatchObject({
    channelIds: [channel],
    // The channel gets the text of the post, which is said once.
    targets: [{ customized: false, text: null, thread: null }],
  });
  // The text of a service begins with the post's own first part when it
  // names none, is replaced by the next, and goes with null.
  expect(
    await patch({ metadata: { mastodon: { thread: [{ text: "More" }] } } }),
  ).toMatchObject({
    targets: [{ customized: true, text: "First", thread: [{ text: "More" }] }],
  });
  expect(
    await patch({ metadata: { mastodon: { text: "Own" } } }),
  ).toMatchObject({
    text: "First",
    targets: [{ customized: true, text: "Own", thread: [] }],
  });
  expect(await patch({ metadata: { mastodon: null } })).toMatchObject({
    targets: [{ customized: false, text: null, thread: null }],
  });
  expect(await patch({ channelIds: [] })).toMatchObject({
    channelIds: [],
    targets: [],
  });

  // Nothing to change is no request, and a draft that goes nowhere is
  // not shared.
  await api.refused(`/posts/${draft.id}`, { method: "PATCH", json: {} }, 400);
  expect(
    await api.refused(
      `/posts/${draft.id}`,
      { method: "PATCH", json: { mode: "shareNow" } },
      400,
    ),
  ).toMatchObject({ field: "channelIds" });
  expect((await api.post(draft.id)).status).toBe("draft");
});

it("changes a scheduled post and keeps its time, shares it, and takes it back", async () => {
  const context = await ready();
  const { api, channel, test } = context;
  const dueAt = new Date(test.clock.time.getTime() + hour).toISOString();
  const later = new Date(test.clock.time.getTime() + 2 * hour).toISOString();
  const post = await api.create({
    text: "Typo",
    channelIds: [channel],
    mode: "customScheduled",
    dueAt,
  });
  const patch = async (json: object) =>
    api.ok(`/posts/${post.id}`, { method: "PATCH", json });

  expect(await patch({ text: "Fixed" })).toMatchObject({
    status: "scheduled",
    mode: "customScheduled",
    dueAt,
    text: "Fixed",
  });
  expect(await patch({ mode: "customScheduled", dueAt: later })).toMatchObject({
    status: "scheduled",
    dueAt: later,
  });
  // A change that the post could not go out with is refused as a whole:
  // the post is scheduled still, with the text that it had.
  expect(
    await api.refused(
      `/posts/${post.id}`,
      { method: "PATCH", json: { text: " " } },
      400,
    ),
  ).toMatchObject({ field: "text" });
  expect(await api.post(post.id)).toMatchObject({
    status: "scheduled",
    dueAt: later,
    text: "Fixed",
  });

  expect(await patch({ saveToDraft: true })).toMatchObject({
    status: "draft",
    mode: null,
    dueAt: null,
  });
  expect(await patch({ text: "Now", mode: "shareNow" })).toMatchObject({
    status: "sending",
  });
  expect((await api.ended(post.id)).status).toBe("sent");
  expect(await published(context, "live")).toEqual(["Now"]);

  // What has gone out is not changed.
  expect(
    await api.refused(
      `/posts/${post.id}`,
      { method: "PATCH", json: { text: "Too late" } },
      409,
    ),
  ).toMatchObject({ error: "InvalidInputError" });
});

it("says a time that is after the year 9999 as the last of that year, and takes none", async () => {
  const { api, channel, browser, workspace } = await ready();
  const lastMoment = "9999-12-31T23:59:59.999Z";
  const draft = await api.create({
    text: "Much later",
    channelIds: [channel],
    saveToDraft: true,
  });
  // The app's own mutator takes every time that a date can hold, so such
  // a time can be in the data: a device schedules the post for the year
  // 20266, which a date writes with six digits.
  const device = new SyncClient();
  await device.connect(browser, workspace);
  device.mutate("post.schedule", {
    id: draft.id,
    dueAt: Date.UTC(20266, 0, 1),
  });
  expect((await device.patch()).rejected).toEqual([]);

  // The runtime sets no alarm for a time after the year 2189: the
  // object comes back within a year, to set the next one.
  const alarmIn = await runInDurableObject(
    objectOf(workspace),
    async (_, state) => ((await state.storage.getAlarm()) ?? 0) - Date.now(),
  );
  expect(alarmIn).toBeGreaterThan(0);
  expect(alarmIn).toBeLessThanOrEqual(farthestLookMs);

  // Every answer that has the post is still one, with a time that the
  // shape of an answer takes.
  expect((await api.post(draft.id)).dueAt).toBe(lastMoment);
  expect((await listOf(api)).posts.map(({ dueAt }) => dueAt)).toEqual([
    lastMoment,
  ]);
  // A change that keeps the time of the post keeps the time that it has,
  // and not the one that the answer said.
  expect(
    await api.ok(`/posts/${draft.id}`, {
      method: "PATCH",
      json: { text: "Much, much later" },
    }),
  ).toMatchObject({ status: "scheduled", dueAt: lastMoment });
  await device.patch();
  expect(device.table("post")).toMatchObject([
    { id: draft.id, dueAt: Date.UTC(20266, 0, 1) },
  ]);

  // A script that sends the whole post back with a change sends the time
  // that the answer said, which is not the one of the row. It asks for
  // nothing new by that, and the post is not moved to the year 9999:
  // with and without a change besides.
  for (const text of ["Later still", "Later still"]) {
    const read = await api.post(draft.id);
    expect(
      await api.ok(`/posts/${draft.id}`, {
        method: "PATCH",
        json: { text, mode: read.mode, dueAt: read.dueAt },
      }),
    ).toMatchObject({ status: "scheduled", text, dueAt: lastMoment });
    await device.patch();
    expect(device.table("post")).toMatchObject([
      { id: draft.id, dueAt: Date.UTC(20266, 0, 1) },
    ]);
  }

  // The API takes the last moment of the year 9999, and nothing later:
  // also not a time of that year which is in the next one in UTC.
  for (const dueAt of [
    "+020266-01-01T00:00:00Z",
    "9999-12-31T23:59:59-01:00",
  ]) {
    expect(
      await api.refused(
        "/posts",
        {
          method: "POST",
          json: {
            text: "Never",
            channelIds: [channel],
            mode: "customScheduled",
            dueAt,
          },
        },
        400,
      ),
    ).toMatchObject({ field: "dueAt" });
  }
  await api.create({
    text: "At the last moment",
    channelIds: [channel],
    mode: "customScheduled",
    dueAt: lastMoment,
  });

  // A key cannot be made to expire later either, and one that is stored
  // with such a time still says whose it is.
  const late = await browser.fetch(`/api/workspaces/${workspace}/api-keys`, {
    method: "POST",
    json: {
      name: "For ever",
      scopes: ["posts:read"],
      expiresAt: Date.UTC(10000, 0, 1),
    },
  });
  expect(late.status).toBe(400);
  expect(await late.json()).toMatchObject({ field: "expiresAt" });
  await env.DB.prepare("update api_key set expires_at = ?")
    .bind(Date.UTC(20266, 0, 1))
    .run();
  expect(await api.ok("/account")).toMatchObject({
    apiKey: { expiresAt: lastMoment },
  });
});

it("fills the queue by the posting schedule, at its end and at its front, and moves a post in it", async () => {
  const { api, channel, test } = await ready();
  // The clock of the test is at 10:00 UTC on a Saturday.
  expect(test.clock.time.toISOString()).toBe("2026-11-14T10:00:00.000Z");
  const slots = [
    "2026-11-14T12:00:00.000Z",
    "2026-11-15T09:00:00.000Z",
    "2026-11-21T12:00:00.000Z",
    "2026-11-22T09:00:00.000Z",
  ];
  const queue = async () =>
    (await listOf(api, "?status=scheduled")).posts
      .sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""))
      .map(({ text, dueAt }) => [text, dueAt]);
  const add = (text: string, mode = "addToQueue") =>
    api.create({ text, channelIds: [channel], mode });

  // Without posting times a post of the queue has no time.
  const a = await add("A");
  expect(a).toMatchObject({
    status: "scheduled",
    mode: "addToQueue",
    dueAt: null,
  });

  expect(
    await setTimes(api, [
      { day: "sat", times: ["12:00"] },
      { day: "sun", times: ["09:00"] },
    ]),
  ).toEqual({
    timeZone: "UTC",
    paused: false,
    schedule: [
      { day: "sun", times: ["09:00"] },
      { day: "mon", times: [] },
      { day: "tue", times: [] },
      { day: "wed", times: [] },
      { day: "thu", times: [] },
      { day: "fri", times: [] },
      { day: "sat", times: ["12:00"] },
    ],
  });
  expect((await api.post(a.id)).dueAt).toBe(slots[0]);

  const b = await add("B");
  const c = await add("C");
  expect(b.dueAt).toBe(slots[1]);
  expect(await queue()).toEqual([
    ["A", slots[0]],
    ["B", slots[1]],
    ["C", slots[2]],
  ]);

  const next = await add("Next", "shareNext");
  expect(next).toMatchObject({ mode: "addToQueue", dueAt: slots[0] });
  expect((await queue()).map(([text]) => text)).toEqual([
    "Next",
    "A",
    "B",
    "C",
  ]);

  const move = (id: string, afterId: string | null) =>
    api.ok(`/posts/${id}/move`, { method: "POST", json: { afterId } });
  expect(await move(c.id, next.id)).toMatchObject({ dueAt: slots[1] });
  expect((await queue()).map(([text]) => text)).toEqual([
    "Next",
    "C",
    "A",
    "B",
  ]);
  expect(await move(b.id, null)).toMatchObject({ dueAt: slots[0] });
  expect((await queue()).map(([text]) => text)).toEqual([
    "B",
    "Next",
    "C",
    "A",
  ]);

  // A post of the queue that is changed stays where it is.
  expect(
    await api.ok(`/posts/${next.id}`, {
      method: "PATCH",
      json: { text: "Second" },
    }),
  ).toMatchObject({ status: "scheduled", mode: "addToQueue", dueAt: slots[1] });
  expect(
    await api.ok(`/posts/${b.id}`, {
      method: "PATCH",
      json: { text: "First" },
    }),
  ).toMatchObject({ dueAt: slots[0] });
  expect(await queue()).toEqual([
    ["First", slots[0]],
    ["Second", slots[1]],
    ["C", slots[2]],
    ["A", slots[3]],
  ]);

  // A post goes after one that is in the queue, and only one that is in
  // the queue moves.
  const draft = await api.create({ text: "Draft", saveToDraft: true });
  for (const afterId of [draft.id, c.id]) {
    expect(
      await api.refused(
        `/posts/${c.id}/move`,
        { method: "POST", json: { afterId } },
        400,
      ),
    ).toMatchObject({ field: "afterId" });
  }
  await api.refused(
    `/posts/${draft.id}/move`,
    { method: "POST", json: { afterId: null } },
    409,
  );
  expect((await queue()).map(([text]) => text)).toEqual([
    "First",
    "Second",
    "C",
    "A",
  ]);
});

it("keeps the place of a queued post that is changed, also when the change says that it is in the queue", async () => {
  const { api, channel } = await ready();
  await setTimes(api, [{ day: "mon", times: ["09:00", "12:00", "15:00"] }]);
  const queued = (text: string) =>
    api.create({ text, channelIds: [channel], mode: "addToQueue" });
  const [first, second, third] = [
    await queued("First"),
    await queued("Second"),
    await queued("Third"),
  ];
  const order = async () =>
    (await listOf(api, "?status=scheduled")).posts
      .sort((a, b) => ((a.dueAt ?? "") < (b.dueAt ?? "") ? -1 : 1))
      .map(({ text }) => text);
  expect(await order()).toEqual(["First", "Second", "Third"]);

  // A script that sends the whole post with every change says the mode
  // that the post has. That asks for nothing new: the post is taken out
  // of the queue to be edited, and goes back to its place, not to the
  // end.
  expect(
    await api.ok(`/posts/${first.id}`, {
      method: "PATCH",
      json: { text: "First, edited", mode: "addToQueue" },
    }),
  ).toMatchObject({ dueAt: first.dueAt, mode: "addToQueue" });
  expect(
    await api.ok(`/posts/${second.id}`, {
      method: "PATCH",
      json: { text: "Second, edited", mode: "addToQueue" },
    }),
  ).toMatchObject({ dueAt: second.dueAt });
  expect(await order()).toEqual(["First, edited", "Second, edited", "Third"]);

  // The front of the queue is another place, which is asked for.
  await api.ok(`/posts/${third.id}`, {
    method: "PATCH",
    json: { text: "Third, edited", mode: "shareNext" },
  });
  expect(await order()).toEqual([
    "Third, edited",
    "First, edited",
    "Second, edited",
  ]);
});

it("sets the posting schedule: the times, the zone and the pause, and refuses what is none", async () => {
  const { api, channel } = await ready();
  expect(await scheduleOf(api)).toMatchObject({
    timeZone: null,
    paused: false,
  });
  const post = await api.create({
    text: "Queued",
    channelIds: [channel],
    mode: "addToQueue",
  });
  const put = (json: object) =>
    api.ok("/posting-schedule", { method: "PUT", json });

  // Times that are named twice count once, and come back in order.
  const set = apiPostingScheduleSchema.parse(
    await put({
      timeZone: "europe/rome",
      schedule: [{ day: "mon", times: ["17:30", "09:00", "17:30"] }],
    }),
  );
  // Under the name that the server has for the zone.
  expect(set.timeZone).toBe("Europe/Rome");
  expect(set.schedule.find(({ day }) => day === "mon")?.times).toEqual([
    "09:00",
    "17:30",
  ]);
  // Monday at 9 in Rome, in winter: 8 in UTC.
  expect((await api.post(post.id)).dueAt).toBe("2026-11-16T08:00:00.000Z");

  // The zone stays when it is left out, and the times are replaced.
  const moved = apiPostingScheduleSchema.parse(
    await put({ schedule: [{ day: "tue", times: ["10:00"] }] }),
  );
  expect(moved.timeZone).toBe("Europe/Rome");
  expect(
    moved.schedule.flatMap(({ day, times }) =>
      times.map((time) => [day, time]),
    ),
  ).toEqual([["tue", "10:00"]]);
  expect((await api.post(post.id)).dueAt).toBe("2026-11-17T09:00:00.000Z");

  // While the queue is paused its posts have no time.
  expect(
    await put({ paused: true, schedule: [{ day: "tue", times: ["10:00"] }] }),
  ).toMatchObject({ paused: true });
  expect((await api.post(post.id)).dueAt).toBeNull();
  // It stays paused when the times change, and goes on when it is told.
  expect(
    await put({ schedule: [{ day: "wed", times: ["10:00"] }] }),
  ).toMatchObject({ paused: true });
  expect((await api.post(post.id)).dueAt).toBeNull();
  expect(
    await put({ paused: false, schedule: [{ day: "wed", times: ["10:00"] }] }),
  ).toMatchObject({ paused: false });
  expect((await api.post(post.id)).dueAt).toBe("2026-11-18T09:00:00.000Z");

  const refuse = (json: object) =>
    api.refused("/posting-schedule", { method: "PUT", json }, 400);
  expect(
    await refuse({ timeZone: "Mars/Olympus", schedule: [] }),
  ).toMatchObject({ field: "timeZone" });
  expect(
    await refuse({ schedule: [{ day: "mon", times: ["9:00"] }] }),
  ).toMatchObject({ field: "schedule.0.times.0" });
  expect(
    await refuse({
      schedule: [
        { day: "mon", times: [] },
        { day: "mon", times: [] },
      ],
    }),
  ).toMatchObject({ field: "schedule" });
  await refuse({});
  // None of those gets as far as the workspace. This one does: its zone
  // is one, and each of its days has as many times as a day may have.
  // Together they are more than a queue has, so the workspace pauses the
  // queue, sets the zone, replaces times, and is refused by the mutator
  // that adds the one too many.
  const before = await scheduleOf(api);
  const minutes = Array.from(
    { length: maxSlots / 2 + 1 },
    (_, minute) =>
      `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`,
  );
  expect(
    await refuse({
      timeZone: "America/New_York",
      schedule: [
        { day: "mon", times: minutes },
        { day: "tue", times: minutes },
      ],
    }),
  ).toMatchObject({ message: expect.stringContaining(`${maxSlots}`) });
  // A refusal changed nothing: not the zone, which was set first, not
  // the pause, which the workspace made for the change, not a time, and
  // not the time of the post in the queue.
  expect(await scheduleOf(api)).toEqual(before);
  expect(before).toEqual({
    timeZone: "Europe/Rome",
    paused: false,
    schedule: expect.arrayContaining([{ day: "wed", times: ["10:00"] }]),
  });
  expect((await api.post(post.id)).dueAt).toBe("2026-11-18T09:00:00.000Z");
  // A posting schedule with no times at all is one too.
  expect(
    apiPostingScheduleSchema
      .parse(await put({ schedule: [] }))
      .schedule.every(({ times }) => times.length === 0),
  ).toBe(true);
  expect((await api.post(post.id)).dueAt).toBeNull();
});

it("gives the posts of the queue their times once when the posting times are replaced", async () => {
  const { api, channel } = await ready();
  const day = (times: string[]) => [{ day: "mon", times }];
  const hours = (from: number) =>
    Array.from(
      { length: 10 },
      (_, index) => `${String(from + index).padStart(2, "0")}:00`,
    );
  await setTimes(api, day(hours(0)));
  const posts = [];
  for (let index = 0; index < 12; index += 1) {
    posts.push(
      await api.create({
        text: `Queued ${index}`,
        channelIds: [channel],
        mode: "addToQueue",
      }),
    );
  }

  // Ten times go and ten others come, and the zone changes: 21 changes,
  // each of which gives every post of the queue its time anew when it is
  // made by itself. That reads the clocks of the zone for every post,
  // the one costly thing that a mutator does. The request pauses the
  // queue for its changes, so it is done once, at the end.
  const before = requeues.timed;
  await api.ok("/posting-schedule", {
    method: "PUT",
    json: { timeZone: "Europe/Rome", schedule: day(hours(10)) },
  });
  expect(requeues.timed - before).toBe(1);

  // The posts have the times that follow from the new ones, in their
  // order: Monday from 10 in Rome, which is 9 in UTC in winter.
  const queued = await Promise.all(posts.map(({ id }) => api.post(id)));
  expect(queued.slice(0, 11).map(({ dueAt }) => dueAt)).toEqual([
    ...Array.from(
      { length: 10 },
      (_, index) =>
        `2026-11-16T${String(9 + index).padStart(2, "0")}:00:00.000Z`,
    ),
    "2026-11-23T09:00:00.000Z",
  ]);
});

it("deletes a post, and neither deletes nor changes one that is being sent", async () => {
  const held = gate((request) => request === postStatus);
  const context = await ready("live", { interceptNetwork: held.intercept });
  const { api, channel } = context;

  const draft = await api.create({ text: "Draft", saveToDraft: true });
  expect(
    (await api.call(`/posts/${draft.id}`, { method: "DELETE" })).status,
  ).toBe(204);
  await api.refused(`/posts/${draft.id}`, {}, 404);
  await api.refused(`/posts/${draft.id}`, { method: "DELETE" }, 404);

  held.close();
  const post = await api.create({
    text: "On its way",
    channelIds: [channel],
    mode: "shareNow",
  });
  await held.reached();
  await api.refused(`/posts/${post.id}`, { method: "DELETE" }, 409);
  await api.refused(
    `/posts/${post.id}`,
    { method: "PATCH", json: { text: "Changed" } },
    409,
  );
  held.open();
  expect((await api.ended(post.id)).status).toBe("sent");

  // What is deleted is pigy's record: the post stays on the network.
  expect(
    (await api.call(`/posts/${post.id}`, { method: "DELETE" })).status,
  ).toBe(204);
  expect(await published(context, "live")).toEqual(["On its way"]);
  expect((await listOf(api)).posts).toEqual([]);
});

it("lists the posts a page at a time, the newest first, by status and by channel", async () => {
  const { api, channel, test } = await ready();
  const ids: string[] = [];
  for (let index = 0; index < 5; index += 1) {
    // Two of them in the same millisecond: their order is still one.
    if (index !== 1) test.advance(1000);
    ids.push(
      (await api.create({ text: `Draft ${index}`, saveToDraft: true })).id,
    );
  }
  const scheduled = await api.create({
    text: "Scheduled",
    channelIds: [channel],
    mode: "customScheduled",
    dueAt: new Date(test.clock.time.getTime() + hour).toISOString(),
  });

  const seen: string[] = [];
  let after = "";
  let pages = 0;
  for (;;) {
    const page = await listOf(api, `?first=2${after}`);
    pages += 1;
    seen.push(...page.posts.map(({ id }) => id));
    expect(page.posts.length).toBeLessThanOrEqual(2);
    if (!page.pageInfo.hasNextPage) break;
    after = `&after=${page.pageInfo.endCursor}`;
  }
  expect(pages).toBe(3);
  // Every post once. The newest first: the two of one moment by their IDs.
  expect([...seen].sort()).toEqual([...ids, scheduled.id].sort());
  expect(seen[0]).toBe(scheduled.id);
  expect(seen.at(-1)).toBe(ids[0]);
  expect(seen[1]).toBe(ids[4]);

  // An empty page says so.
  expect(await listOf(api, "?status=sent")).toEqual({
    posts: [],
    pageInfo: { hasNextPage: false, endCursor: null },
  });
  expect(
    (await listOf(api, "?status=scheduled,sent")).posts.map(({ id }) => id),
  ).toEqual([scheduled.id]);
  expect((await listOf(api, "?status=draft&first=100")).posts).toHaveLength(5);
  // Two statuses are two walks, of which the newest posts are the page:
  // the pages are the ones of all posts, here, in the same order, also
  // for a status that is named twice.
  const both: string[] = [];
  for (let cursor = ""; ; ) {
    const page = await listOf(
      api,
      `?status=draft,scheduled,draft&first=4${cursor}`,
    );
    both.push(...page.posts.map(({ id }) => id));
    if (!page.pageInfo.hasNextPage) break;
    cursor = `&after=${page.pageInfo.endCursor}`;
  }
  expect(both).toEqual(seen);
  expect(
    (await listOf(api, `?channelId=${channel}`)).posts.map(({ id }) => id),
  ).toEqual([scheduled.id]);

  for (const [query, field] of [
    ["?after=nonsense", "after"],
    ["?first=0", "first"],
    ["?first=101", "first"],
    ["?first=two", "first"],
    ["?status=published", "status.0"],
    ["?channelId=mine", "channelId"],
  ] as const) {
    expect(await api.refused(`/posts${query}`, {}, 400), query).toMatchObject({
      error: "InvalidInputError",
      field,
    });
  }
  await api.refused("/posts?limit=2", {}, 400);
});

it("reads a page of posts by walking down an index from the cursor on, without a sort", async () => {
  const { api, workspace, channel } = await ready();
  // The workspace has its tables once it was used.
  await api.create({ text: "One", saveToDraft: true });
  const from = { id: "01939c2e-0000-7000-8000-000000000000", createdAt: 1 };
  const plans = await runInDurableObject(objectOf(workspace), (_, state) => {
    const db = drizzle(state.storage);
    // What SQLite says that it does for the question that the API asks.
    const planOf = (query: Parameters<typeof postsPage>[1]) => {
      const { sql, params } = postsPage(db, query).toSQL();
      return state.storage.sql
        .exec<{ detail: string }>(`explain query plan ${sql}`, ...params)
        .toArray()
        .map(({ detail }) => detail);
    };
    return {
      all: planOf({ limit: 21 }),
      allAfter: planOf({ limit: 21, from }),
      ofStatus: planOf({ limit: 21, status: "sent" }),
      ofStatusAfter: planOf({ limit: 21, status: "sent", from }),
      ofChannelAfter: planOf({ limit: 21, channelId: channel, from }),
    };
  });
  // Each is one walk down an index that has the posts in the order of
  // the page: a search from the cursor on, not a scan of the posts
  // before it, and no step that sorts, which SQLite calls a temporary
  // B-tree. The posts of a channel are those of the walk that have a
  // target for it.
  const channelTarget =
    "SEARCH post_target EXISTS USING COVERING INDEX post_target_post_id_channel_id_idx (post_id=? AND channel_id=?)";
  expect(plans).toEqual({
    all: ["SCAN post USING INDEX post_created_at_idx"],
    allAfter: [
      "SEARCH post USING INDEX post_created_at_idx ((created_at,id)<(?,?))",
    ],
    ofStatus: ["SEARCH post USING INDEX post_status_created_at_idx (status=?)"],
    ofStatusAfter: [
      "SEARCH post USING INDEX post_status_created_at_idx (status=? AND (created_at,id)<(?,?))",
    ],
    ofChannelAfter: [
      "SEARCH post USING INDEX post_created_at_idx ((created_at,id)<(?,?))",
      channelTarget,
    ],
  });
  expect(JSON.stringify(plans)).not.toContain("TEMP B-TREE");
});

it("shows the clients of the app what the API did, as it does it", async () => {
  const { api, channel, browser, workspace } = await ready();
  const client = new SyncClient();
  await client.connect(browser, workspace);

  const post = await api.create({
    text: "From a script",
    channelIds: [channel],
    saveToDraft: true,
    metadata: { thread: [{ text: "And on" }] },
  });
  // One patch for the whole call: the client never has half a post.
  await client.patch();
  expect(client.table("post")).toMatchObject([
    { id: post.id, status: "draft" },
  ]);
  expect(
    client
      .table("post_part")
      .sort((a, b) => a.position - b.position)
      .map(({ text }) => text),
  ).toEqual(["From a script", "And on"]);
  expect(client.table("post_target")).toMatchObject([
    { postId: post.id, channelId: channel, status: "pending" },
  ]);

  // And the other way round: what the app does is what the API reads.
  const [part] = client
    .table("post_part")
    .sort((a, b) => a.position - b.position);
  client.mutate("part.setText", { id: part?.id ?? "", text: "From the app" });
  await client.patch();
  expect((await api.post(post.id)).text).toBe("From the app");

  await api.call(`/posts/${post.id}`, { method: "DELETE" });
  await client.patch();
  expect(client.table("post")).toEqual([]);
  expect(client.table("post_part")).toEqual([]);
});
