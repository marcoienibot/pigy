import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Environment, MutatorArgs, MutatorName } from "@pigy/core";
import { apiPostListSchema } from "@pigy/core/api";
import { feed } from "@pigy/simulators/world";
import { describe, expect, it, onTestFinished } from "vitest";
import { apiClient, makeKey, startedApi } from "./api.ts";
import { connectInSandbox, disconnected } from "./channels.ts";
import { type Browser, expectWarnings, vapidPrivateKey } from "./helpers.ts";
import { connectAccount, gate, postStatus } from "./publishing.ts";
import { idle, keptEndpoints, received, turnOn } from "./push.ts";
import { identityOf, objectOf, SyncClient } from "./sync-client.ts";

/**
 * What the public API does next to the inbox, the Queue screen and the
 * Channels screen of the app: what it makes is told of as what a person
 * makes, and what a person has done to a post is what the API says of it.
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
  let channel: string;
  if (environment === "live") {
    channel = await connectAccount(test, browser, workspace);
  } else {
    channel = (await connectInSandbox(browser, workspace)).channel ?? "";
  }
  const { secret } = await makeKey(browser, workspace);
  const api = apiClient(test, secret);
  /** The texts that are on the real network, in the order they were posted. */
  const posts = () => feed(test.network.world).map(({ post }) => post.text);
  return { ...context, workspace, channel, api, secret, posts };
}

/** The inbox of a workspace as a client that has just connected sees it. */
async function inbox(browser: Browser, workspace: string) {
  const client = new SyncClient();
  await client.connect(browser, workspace);
  return client
    .table("notification")
    .map(({ id, kind }) => ({ id, kind }))
    .sort((a, b) => (a.kind < b.kind ? -1 : 1));
}

/** Runs the alarm of the workspace, which has to be set. */
async function alarm(workspace: string) {
  expect(await runDurableObjectAlarm(objectOf(workspace))).toBe(true);
}

describe.each(["live", "sandbox"] as const)(
  "with a key of a %s workspace",
  (environment) => {
    it("tells the inbox and the devices of a post that the API shared and that failed, as of one that a person shared", async () => {
      onTestFinished(idle);
      const { test, browser, workspace, channel, api, secret } = await ready(
        environment,
        { env: { VAPID_PRIVATE_KEY: vapidPrivateKey } },
      );
      expectWarnings();
      const phone = await turnOn(test, browser);
      // The network takes the access back, which ends the delivery at
      // once and is two things to tell of: the post and the account.
      const fault = { kind: "token-revoked", operation: "publish" } as const;
      if (environment === "live") {
        test.network.mastodon.arm(fault);
      } else {
        const armed = await browser.fetch("/api/sandbox/faults", {
          method: "POST",
          json: { network: "mastodon", ...fault },
        });
        expect(armed.status).toBe(200);
      }

      const { id } = await api.create({
        text: "Refused",
        channelIds: [channel],
        mode: "shareNow",
      });

      expect(await api.ended(id)).toMatchObject({
        status: "error",
        // The delivery failed by itself: nobody disconnected the account.
        targets: [{ status: "error", disconnected: false }],
      });
      expect(await inbox(browser, workspace)).toEqual([
        { id: channel, kind: "channel_needs_reconnect" },
        { id, kind: "post_failed" },
      ]);
      expect(await received(test, phone, 2)).toContainEqual({
        v: 1,
        kind: "post_failed",
        workspaceId: workspace,
        environment,
        postId: id,
      });

      // The devices are the sessions' to manage: a key is nobody there,
      // and none of its requests has touched what the app keeps of them.
      const asKey = await test.browser().fetch("/api/push/subscription", {
        method: "DELETE",
        json: { endpoint: phone.endpoint },
        headers: { Authorization: `Bearer ${secret}` },
      });
      expect(asKey.status).toBe(401);
      expect(await keptEndpoints(test)).toEqual([phone.endpoint]);

      // With the post goes what the inbox says of it. The account still
      // has to be connected again.
      expect(
        (await api.call(`/posts/${id}`, { method: "DELETE" })).status,
      ).toBe(204);
      expect(await inbox(browser, workspace)).toEqual([
        { id: channel, kind: "channel_needs_reconnect" },
      ]);
    });
  },
);

it("says of a scheduled post that it is held, changes it, shares it and deletes it, and leaves nothing of it in the inbox", async () => {
  const { test, browser, workspace, channel, api, posts } = await ready();
  const dueAt = new Date(test.clock.time.getTime() + minute).toISOString();
  const scheduled = (text: string) =>
    api.create({ text, channelIds: [channel], mode: "customScheduled", dueAt });
  const first = await scheduled("First");
  const second = await scheduled("Second");

  // The object could not run for two hours: it finds the posts too late.
  test.advance(2 * hour);
  await alarm(workspace);

  const held = await api.post(first.id);
  expect(held).toMatchObject({ status: "scheduled", dueAt });
  expect(held.heldAt).toEqual(expect.any(String));
  expect(posts()).toEqual([]);
  // A held post is a scheduled one for a script that lists them.
  const listed = apiPostListSchema.parse(
    await api.ok("/posts?status=scheduled"),
  );
  expect(listed.posts.map(({ id }) => id).sort()).toEqual(
    [first.id, second.id].sort(),
  );
  expect(await inbox(browser, workspace)).toEqual(
    [
      { id: first.id, kind: "post_held" },
      { id: second.id, kind: "post_held" },
    ].sort((a, b) => (a.id < b.id ? -1 : 1)),
  );

  // A change of the text keeps the time, which is still missed: the post
  // is held still and goes nowhere, and the inbox has one notification
  // of it, not two.
  const edited = await api.ok(`/posts/${first.id}`, {
    method: "PATCH",
    json: { text: "First, edited" },
  });
  expect(edited).toMatchObject({ status: "scheduled", dueAt });
  expect(edited).toHaveProperty("heldAt", expect.any(String));
  expect(posts()).toEqual([]);
  expect(await inbox(browser, workspace)).toHaveLength(2);

  // Deleted, a held post is gone at once, with what the inbox said.
  expect(
    (await api.call(`/posts/${second.id}`, { method: "DELETE" })).status,
  ).toBe(204);
  expect(await inbox(browser, workspace)).toEqual([
    { id: first.id, kind: "post_held" },
  ]);

  // Shared now, it goes out, and nobody has to decide any more.
  await api.ok(`/posts/${first.id}`, {
    method: "PATCH",
    json: { mode: "shareNow" },
  });
  expect(await api.ended(first.id)).toMatchObject({
    status: "sent",
    heldAt: null,
  });
  expect(await inbox(browser, workspace)).toEqual([]);
  // The deleted post has not gone out, and nothing went out twice.
  expect(posts()).toEqual(["First, edited"]);
});

it("has nothing of a scheduled post that somebody put aside in the app, until they take that back", async () => {
  const { test, workspace, channel, api } = await ready();
  const dueAt = new Date(test.clock.time.getTime() + hour).toISOString();
  const post = await api.create({
    text: "Scheduled",
    channelIds: [channel],
    mode: "customScheduled",
    dueAt,
  });
  /** What a person does on the Queue screen. */
  const inApp = async <Name extends MutatorName>(
    name: Name,
    args: MutatorArgs<Name>,
  ) =>
    expect(
      await env.WORKSPACE.getByName(workspace).mutate(
        await identityOf(test, workspace),
        name,
        args,
      ),
    ).toEqual({ ok: true });

  // "Delete", while its Undo is offered.
  await inApp("post.trash", { id: post.id });

  await api.refused(`/posts/${post.id}`, {}, 404);
  expect(apiPostListSchema.parse(await api.ok("/posts")).posts).toEqual([]);
  // A script cannot change it either, which would bring it back, or
  // delete what a person may still take back.
  await api.refused(
    `/posts/${post.id}`,
    { method: "PATCH", json: { text: "Changed" } },
    404,
  );
  await api.refused(`/posts/${post.id}`, { method: "DELETE" }, 404);

  // "Undo".
  await inApp("post.restore", { id: post.id });
  expect(await api.post(post.id)).toMatchObject({
    status: "scheduled",
    text: "Scheduled",
    dueAt,
  });
});

it("says of a delivery that it ended because its account was disconnected, which the inbox does not tell of", async () => {
  const holds = gate((request) => request === postStatus);
  const { browser, workspace, channel, api } = await ready("live", {
    interceptNetwork: holds.intercept,
  });
  expectWarnings();
  holds.close();
  const post = await api.create({
    text: "On its way",
    channelIds: [channel],
    mode: "shareNow",
  });
  await holds.reached();

  // The person disconnects the account while the post is on its way.
  await disconnected(browser, workspace, channel);
  holds.open();

  expect(await api.ended(post.id)).toMatchObject({
    status: "error",
    channelIds: [channel],
    targets: [
      {
        channelId: channel,
        // The channel is gone, and with it what says which network it was.
        service: null,
        status: "error",
        disconnected: true,
        error: expect.stringContaining("disconnected"),
      },
    ],
  });
  // They did that themselves: there is nothing to tell them.
  expect(await inbox(browser, workspace)).toEqual([]);
});
