import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { mutators, uuidv7 } from "@pigy/core";
import {
  type ApiOperation,
  apiOperations,
  apiPostListSchema,
  apiPostSchema,
  apiRateLimit,
  apiTargetSchema,
  maxApiAnswerTextLength,
  maxApiBodyBytes,
  maxApiChannels,
  openApiDocument,
} from "@pigy/core/api";
import { feed } from "@pigy/simulators/world";
import { expect, it, vi } from "vitest";
import { apiRoutes } from "../src/api/routes.ts";
import type { AppDependencies } from "../src/env.ts";
import { WorkspaceStore } from "../src/workspace/store.ts";
import { mutateWorkspace } from "../src/workspace/workspaces.ts";
import { type ApiClient, apiClient, makeKey, startedApi } from "./api.ts";
import { connectInSandbox } from "./channels.ts";
import { expectErrors, invite, signedIn } from "./helpers.ts";
import { connectAccount, started } from "./publishing.ts";
import {
  identityOf,
  objectOf,
  SyncClient,
  workspaceIds,
} from "./sync-client.ts";

/**
 * What keeps the public API safe to hand a key for: what a key reaches,
 * what a request that is repeated does, how many requests a key may make,
 * and that the document describes the routes that are there.
 */

/**
 * The method of the store that runs every mutator, which is private to it,
 * for a test that makes it fail: the objects run in the isolate of the
 * test and share its modules.
 */
const store = WorkspaceStore.prototype as unknown as {
  run: (...args: unknown[]) => unknown;
};
const runMutations = store.run;

const listOf = async (api: ApiClient, query = "") =>
  apiPostListSchema.parse(await api.ok(`/posts${query}`));

/**
 * The delivery of the post `postId` to `channelId`, in the strict shape
 * that the document promises. Not through `ok` of the client, which takes
 * a body with an `error` for a refusal: a target has one, of its delivery.
 */
async function targetOf(api: ApiClient, postId: string, channelId: string) {
  const response = await api.call(`/posts/${postId}/targets/${channelId}`);
  expect(response.status).toBe(200);
  return apiTargetSchema.parse(await response.json());
}

/** A path of `operation`, with an ID that names nothing in the place of one. */
const pathOf = ({ path }: ApiOperation) =>
  path.replace(/\{\w+\}/g, "01939c2e-0000-7000-8000-000000000000");

it("holds a key to its scopes, route by route", async () => {
  const { test, browser, workspaces } = await startedApi();
  const keyWith = async (
    ...scopes: ("posts:read" | "posts:write" | "channels:read")[]
  ) =>
    apiClient(
      test,
      (await makeKey(browser, workspaces.live, { scopes })).secret,
    );
  const clients = {
    "posts:read": await keyWith("posts:read"),
    "posts:write": await keyWith("posts:write"),
    "channels:read": await keyWith("channels:read"),
  };

  for (const operation of Object.values<ApiOperation>(apiOperations)) {
    for (const [scope, api] of Object.entries(clients)) {
      const response = await api.call(pathOf(operation), {
        method: operation.method.toUpperCase(),
        ...(operation.request && { json: {} }),
      });
      const allowed = operation.scope === null || operation.scope === scope;
      const where = `${operation.method} ${operation.path} with ${scope}`;
      if (allowed) {
        // Let through to the route, which makes of the request what it is.
        expect(response.status, where).not.toBe(403);
        expect(response.status, where).not.toBe(401);
      } else {
        expect(response.status, where).toBe(403);
        expect(await response.json(), where).toEqual({
          error: "UnauthorizedError",
          message: `This API key does not have the scope ${operation.scope}`,
        });
      }
    }
  }
  // A key that may write and not read made nothing by trying.
  expect((await listOf(clients["posts:read"])).posts).toEqual([]);
});

it("lets a key reach its own workspace and no other: not the other environment, not another person", async () => {
  const { test, browser, workspaces } = await startedApi();
  const liveChannel = await connectAccount(test, browser, workspaces.live);
  const sandboxChannel = (await connectInSandbox(browser, workspaces.sandbox))
    .channel;
  const live = apiClient(
    test,
    (await makeKey(browser, workspaces.live)).secret,
  );
  const sandbox = apiClient(
    test,
    (await makeKey(browser, workspaces.sandbox)).secret,
  );
  await invite(test, "member@example.com");
  const member = await signedIn(test, { email: "member@example.com" });
  const others = apiClient(
    test,
    (await makeKey(member, (await workspaceIds(member)).live)).secret,
  );

  const post = await live.create({
    text: "Mine",
    channelIds: [liveChannel],
    saveToDraft: true,
  });

  for (const api of [sandbox, others]) {
    // Not there to read, to change, to move or to delete.
    await api.refused(`/posts/${post.id}`, {}, 404);
    await api.refused(
      `/posts/${post.id}`,
      { method: "PATCH", json: { text: "Theirs" } },
      404,
    );
    await api.refused(
      `/posts/${post.id}/move`,
      { method: "POST", json: { afterId: null } },
      404,
    );
    await api.refused(`/posts/${post.id}`, { method: "DELETE" }, 404);
    await api.refused(`/channels/${liveChannel}`, {}, 404);
    expect((await listOf(api)).posts).toEqual([]);
    // A channel of another workspace is no channel to post to.
    expect(
      await api.refused(
        "/posts",
        {
          method: "POST",
          json: {
            text: "Borrowed",
            channelIds: [liveChannel],
            mode: "shareNow",
          },
        },
        400,
      ),
    ).toMatchObject({ field: "channelIds" });
  }
  expect((await live.post(post.id)).text).toBe("Mine");
  await live.refused(`/channels/${sandboxChannel}`, {}, 404);
  expect(feed(test.network.world)).toEqual([]);
});

it("takes a key and never the session: a page cannot call the API as the person who looks at it", async () => {
  const { test, browser, workspaces } = await startedApi();
  const { secret } = await makeKey(browser, workspaces.live);

  // The browser of the person, with their cookie, from a page of pigy.
  expect((await browser.fetch("/api/v1/posts")).status).toBe(401);
  const made = await browser.fetch("/api/v1/posts", {
    method: "POST",
    json: { text: "From a page", saveToDraft: true },
  });
  expect(made.status).toBe(401);
  expect((await listOf(apiClient(test, secret))).posts).toEqual([]);

  // A page of another site cannot send a key: the browser asks first,
  // and is told nothing that would let the request through.
  const preflight = await test.browser().fetch("/api/v1/posts", {
    method: "OPTIONS",
    headers: {
      Origin: "https://elsewhere.example",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization, content-type",
    },
  });
  expect(preflight.ok).toBe(false);
  const answered = await apiClient(test, secret).call("/posts", {
    headers: { Origin: "https://elsewhere.example" },
  });
  for (const response of [preflight, answered]) {
    expect(
      [...response.headers.keys()].filter((name) =>
        name.startsWith("access-control-"),
      ),
    ).toEqual([]);
  }
  // What a key reads is not for a cache to keep.
  expect(answered.headers.get("Cache-Control")).toBe("no-store");
});

it("carries a request out once for its Idempotency-Key, and answers a repeat as the first", async () => {
  const { test, browser, workspaces } = await startedApi();
  const channel = await connectAccount(test, browser, workspaces.live);
  const api = apiClient(test, (await makeKey(browser, workspaces.live)).secret);
  const other = apiClient(
    test,
    (await makeKey(browser, workspaces.live)).secret,
  );
  const json = { text: "Once", channelIds: [channel], mode: "shareNow" };
  const key = { "Idempotency-Key": "order-1" };

  const post = (headers: Record<string, string>) =>
    api.call("/posts", { method: "POST", json, headers });
  const created = await post(key);
  expect(created.status).toBe(201);
  expect(created.headers.get("Idempotent-Replayed")).toBeNull();
  const first = apiPostSchema.parse(await created.json());
  expect(first.status).toBe("sending");
  const sent = await api.ended(first.id);
  expect(sent.status).toBe("sent");
  // The repeat makes no second post, and says that it is a repeat. It is
  // answered with the status of the first answer, and with the post as it
  // is now: sent, which it was not when the first answer was given.
  const repeated = await post(key);
  expect(repeated.status).toBe(201);
  expect(repeated.headers.get("Idempotent-Replayed")).toBe("true");
  expect(await repeated.json()).toEqual(sent);
  expect((await listOf(api)).posts).toHaveLength(1);
  expect(feed(test.network.world).map(({ post }) => post.text)).toEqual([
    "Once",
  ]);

  // The same key with another request is refused, and changes nothing.
  for (const [path, init] of [
    ["/posts", { method: "POST", json: { ...json, text: "Twice" } }],
    [`/posts/${first.id}`, { method: "DELETE" }],
  ] as const) {
    expect(await api.refused(path, { ...init, headers: key }, 422)).toEqual({
      error: "InvalidInputError",
      message: expect.stringContaining("Idempotency-Key"),
    });
  }
  expect((await listOf(api)).posts).toHaveLength(1);

  // The key is the API key's own: another key that sends the same header
  // makes a request of its own. And without the header every request is
  // carried out.
  const second = await other.create(
    { ...json, mode: undefined, saveToDraft: true },
    key,
  );
  expect(second.id).not.toBe(first.id);
  await api.create({ text: "Draft", saveToDraft: true });
  await api.create({ text: "Draft", saveToDraft: true });
  expect((await listOf(api)).posts).toHaveLength(4);

  await api.refused(
    "/posts",
    { method: "POST", json, headers: { "Idempotency-Key": "two words" } },
    400,
  );
  await api.refused(
    "/posts",
    { method: "POST", json, headers: { "Idempotency-Key": "k".repeat(256) } },
    400,
  );
});

it("answers the repeat of a refused request with the refusal, whatever has changed since", async () => {
  const { test, browser, workspaces } = await startedApi();
  const channel = await connectAccount(test, browser, workspaces.live);
  const api = apiClient(test, (await makeKey(browser, workspaces.live)).secret);
  const draft = await api.create({
    text: "Not in the queue yet",
    channelIds: [channel],
    saveToDraft: true,
  });
  const move = (key: string) =>
    api.call(`/posts/${draft.id}/move`, {
      method: "POST",
      json: { afterId: null },
      headers: { "Idempotency-Key": key },
    });

  const refused = await move("move-1");
  expect(refused.status).toBe(409);
  const refusal = await refused.json();

  await api.ok(`/posts/${draft.id}`, {
    method: "PATCH",
    json: { mode: "addToQueue" },
  });
  // What is kept of the refusal is from the version of pigy that gave
  // it, and is said again as it is, whatever a later version would keep:
  // here it has something that this version does not know.
  await runInDurableObject(objectOf(workspaces.live), (_, state) => {
    state.storage.sql.exec(
      `update keyed_call set outcome =
         json_set(outcome, '$.answer.since', 'another version')
       where key like 'api:%'`,
    );
  });
  // The request would be taken now, as the one with a new key is. The
  // repeat is not a new request: it is answered as it was, and says so.
  const repeated = await move("move-1");
  expect(repeated.status).toBe(409);
  expect(repeated.headers.get("Idempotent-Replayed")).toBe("true");
  expect(await repeated.json()).toEqual(refusal);
  const moved = await move("move-2");
  expect(moved.status).toBe(200);
  expect(moved.headers.get("Idempotent-Replayed")).toBeNull();

  // The repeat of a request whose post is gone since makes no post, and
  // says that there is none.
  const made = { text: "Made once", saveToDraft: true };
  const once = { "Idempotency-Key": "make-1" };
  const { id } = await api.create(made, once);
  expect((await api.call(`/posts/${id}`, { method: "DELETE" })).status).toBe(
    204,
  );
  const gone = await api.call("/posts", {
    method: "POST",
    json: made,
    headers: once,
  });
  expect(gone.status).toBe(404);
  expect(gone.headers.get("Idempotent-Replayed")).toBe("true");
  expect((await listOf(api)).posts.map(({ text }) => text)).toEqual([
    "Not in the queue yet",
  ]);
});

/**
 * Gives a workspace `count` channels that no network knows of: the first
 * `onMastodon` of them of Mastodon, the others of Bluesky.
 */
async function manyChannels(
  test: Parameters<typeof identityOf>[0] & { clock: { time: Date } },
  workspaceId: string,
  count: number,
  onMastodon: number,
): Promise<string[]> {
  const workspace = await identityOf(test, workspaceId);
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = uuidv7(test.clock.time);
    // Run by the Worker, as the connect callback does: nothing of this
    // test is about the access of a channel.
    expect(
      await mutateWorkspace(env.WORKSPACE, workspace, "channel.connect", {
        id,
        network: index < onMastodon ? "mastodon" : "bluesky",
        accountId: `account-${index}`,
        handle: `@account${index}@mastodon.example`,
        name: `Account ${index}`,
        avatarUrl: null,
        profileUrl: null,
        expiresAt: null,
        limits: null,
      }),
    ).toEqual({ ok: true });
    ids.push(id);
  }
  return ids;
}

it("keeps a small record of a large post under its Idempotency-Key, and answers within its budget", async () => {
  const { test, browser, workspaces } = await startedApi();
  const api = apiClient(test, (await makeKey(browser, workspaces.live)).secret);
  const channelIds = await manyChannels(
    test,
    workspaces.live,
    maxApiChannels,
    5,
  );
  const part = "x".repeat(10_000);
  const thread = Array.from({ length: 24 }, () => ({ text: part }));
  // A draft may hold anything: a thread of a quarter of a million
  // characters for fifty channels, in a body just under the limit.
  const request = {
    method: "POST",
    json: { text: part, metadata: { thread }, channelIds, saveToDraft: true },
    headers: { "Idempotency-Key": "large-1" },
  };
  expect(JSON.stringify(request.json).length).toBeGreaterThan(250_000);
  expect(JSON.stringify(request.json).length).toBeLessThan(maxApiBodyBytes);

  // The answer says the text of the post once, and not once more for
  // each channel that gets it.
  const created = await api.call("/posts", request);
  expect(created.status).toBe(201);
  const text = await created.text();
  expect(text.length).toBeLessThan(300_000);
  const post = apiPostSchema.parse(JSON.parse(text));
  expect(post.targets).toHaveLength(maxApiChannels);
  expect(post.targets.every((target) => target.text === null)).toBe(true);

  // What is kept for the repeats is a few hundred bytes, whatever the
  // post: the answer itself would not fit into a row.
  const kept = await runInDurableObject(objectOf(workspaces.live), (_, state) =>
    state.storage.sql
      .exec<{ size: number }>(
        "select length(outcome) as size from keyed_call where key like 'api:%'",
      )
      .toArray(),
  );
  expect(kept).toEqual([{ size: expect.any(Number) }]);
  expect(kept[0]?.size).toBeLessThan(500);
  const repeated = await api.call("/posts", request);
  expect(repeated.status).toBe(201);
  expect(repeated.headers.get("Idempotent-Replayed")).toBe("true");
  expect(await repeated.json()).toEqual(post);

  // The five channels of Mastodon are given a text of their own, as long
  // as the post's. That is a million and a quarter characters with the
  // post's own, and an answer carries a million at most: the post's and
  // the texts of three channels. Of the other two it says that it left
  // their text out, which a null alone would not: a channel without a
  // text of its own says null too, and gets the text of the post.
  const customized = await api.call(`/posts/${post.id}`, {
    method: "PATCH",
    json: { metadata: { mastodon: { text: part, thread } } },
    headers: { "Idempotency-Key": "large-2" },
  });
  expect(customized.status).toBe(200);
  const large = await customized.text();
  expect(large.length).toBeLessThan(maxApiAnswerTextLength + 50_000);
  const { targets } = apiPostSchema.parse(JSON.parse(large));
  const own = targets.filter((target) => target.customized);
  expect(own).toHaveLength(5);
  const said = own.filter((target) => !target.textOmitted);
  const omitted = own.filter((target) => target.textOmitted);
  expect(said).toHaveLength(3);
  for (const target of said) {
    expect(target).toMatchObject({ text: part, thread });
  }
  expect(omitted).toMatchObject([
    { text: null, thread: null },
    { text: null, thread: null },
  ]);
  // Nothing is said to be left out of a channel that has no text of its
  // own: it has none to leave out.
  const follows = targets.filter((target) => !target.customized);
  expect(follows).toHaveLength(maxApiChannels - 5);
  expect(follows.every((target) => !target.textOmitted)).toBe(true);

  // What was left out can be read, a channel at a time, and is whole
  // there: the rest of the target is as the post said it.
  for (const target of omitted) {
    expect(await targetOf(api, post.id, target.channelId)).toEqual({
      ...target,
      text: part,
      thread,
      textOmitted: false,
    });
  }
  // The same in the other answers that have the post: a read, and the
  // repeat of the request that changed it.
  expect((await api.post(post.id)).targets).toEqual(targets);
  const again = await api.call(`/posts/${post.id}`, {
    method: "PATCH",
    json: { metadata: { mastodon: { text: part, thread } } },
    headers: { "Idempotency-Key": "large-2" },
  });
  expect(again.headers.get("Idempotent-Replayed")).toBe("true");
  expect(apiPostSchema.parse(await again.json()).targets).toEqual(targets);

  // A channel that gets the text of the post says so there too, and a
  // channel that the post does not go to, or a post that is not there,
  // is a 404.
  const [follower] = follows;
  if (!follower) throw new Error("Every channel has a text of its own");
  expect(await targetOf(api, post.id, follower.channelId)).toEqual(follower);
  const elsewhere = "01939c2e-0000-7000-8000-000000000000";
  expect(
    await api.refused(`/posts/${post.id}/targets/${elsewhere}`, {}, 404),
  ).toEqual({
    error: "NotFoundError",
    message: "The post does not go to this channel",
  });
  expect(
    await api.refused(
      `/posts/${elsewhere}/targets/${omitted[0]?.channelId}`,
      {},
      404,
    ),
  ).toEqual({ error: "NotFoundError", message: "There is no such post" });

  // A page ends before the post that it has no room for, and the next
  // one begins with it.
  await api.create({ text: "Small", saveToDraft: true });
  const first = await listOf(api, "?first=2");
  expect(first.posts.map(({ text }) => text)).toEqual(["Small"]);
  expect(first.pageInfo.hasNextPage).toBe(true);
  const next = await api.call(
    `/posts?first=2&after=${first.pageInfo.endCursor}`,
  );
  const page = await next.text();
  expect(page.length).toBeLessThan(maxApiAnswerTextLength + 50_000);
  // The post is whole on its page, as it is by itself: a page never has
  // a part of a post, and what the post leaves out it says there too.
  const listed = apiPostListSchema.parse(JSON.parse(page));
  expect(listed.pageInfo.hasNextPage).toBe(false);
  expect(listed.posts).toHaveLength(1);
  expect(listed.posts[0]?.targets).toEqual(targets);
});

it("keeps nothing of a request that a bug of pigy's failed, and carries it out when it is repeated", async () => {
  const { test, browser, workspaces } = await startedApi();
  const channel = await connectAccount(test, browser, workspaces.live);
  const api = apiClient(test, (await makeKey(browser, workspaces.live)).secret);
  const request = {
    method: "POST",
    json: { text: "After the fix", channelIds: [channel], saveToDraft: true },
    headers: { "Idempotency-Key": "bug-1" },
  };

  // A mutator throws what is no refusal: a bug, which the store answers
  // the mutation with as an error of its own.
  const errors = expectErrors();
  const bug = vi
    .spyOn(mutators["target.add"], "apply")
    .mockImplementationOnce(() => {
      throw new Error("A bug of the mutator");
    });
  const failed = await api.refused("/posts", request, 500);
  expect(failed).toEqual({
    error: "UnexpectedError",
    message: "Something went wrong",
  });
  expect(bug).toHaveBeenCalledTimes(1);
  expect(errors).toHaveBeenCalled();
  expect((await listOf(api)).posts).toEqual([]);

  // The bug is fixed. The repeat is the request for the first time: a
  // 500 that was kept under the key would be its answer for 30 days.
  const response = await api.call("/posts", request);
  expect(response.status).toBe(201);
  expect(response.headers.get("Idempotent-Replayed")).toBeNull();
  expect((await listOf(api)).posts.map(({ text }) => text)).toEqual([
    "After the fix",
  ]);
});

it("leaves nothing of a request that failed in its middle, and carries it out when it is repeated", async () => {
  const { test, browser, workspaces } = await startedApi();
  const channel = await connectAccount(test, browser, workspaces.live);
  const api = apiClient(test, (await makeKey(browser, workspaces.live)).secret);
  const client = new SyncClient();
  await client.connect(browser, workspaces.live);
  const request = {
    method: "POST",
    json: {
      text: "One",
      channelIds: [channel],
      mode: "shareNow",
      metadata: { thread: [{ text: "Two" }] },
    },
    headers: { "Idempotency-Key": "retry-1" },
  };

  // The database of the workspace gives up at the third mutation of the
  // call: the post and its second part are written by then.
  const errors = expectErrors();
  let calls = 0;
  const run = vi.spyOn(store, "run").mockImplementation(function (
    this: WorkspaceStore,
    ...args
  ) {
    calls += 1;
    if (calls === 3) throw new Error("The disk of the workspace is gone");
    return Reflect.apply(runMutations, this, args);
  });
  const failed = await api.call("/posts", request);
  run.mockRestore();
  expect(calls).toBe(3);
  expect(failed.status).toBe(500);
  expect(await failed.json()).toEqual({
    error: "UnexpectedError",
    message: "Something went wrong",
  });
  expect(errors).toHaveBeenCalled();

  // Nothing is left of it, in the workspace or with a client of the app.
  expect((await listOf(api)).posts).toEqual([]);
  const fresh = new SyncClient();
  await fresh.connect(browser, workspaces.live);
  expect(fresh.table("post")).toEqual([]);
  expect(fresh.table("post_part")).toEqual([]);
  expect(client.table("post")).toEqual([]);

  // A request that failed in the workspace has not happened: its repeat
  // is carried out, once, and the one after that is answered with it.
  const response = await api.call("/posts", request);
  expect(response.status).toBe(201);
  const post = await response.json();
  expect(await (await api.call("/posts", request)).json()).toEqual(post);
  expect((await listOf(api)).posts).toHaveLength(1);
  expect((await api.ended((post as { id: string }).id)).status).toBe("sent");
  expect(feed(test.network.world).map(({ post }) => post.text)).toEqual([
    "One",
    "Two",
  ]);
});

it("does what a change takes only for a call that changed something", async () => {
  const { test, browser, workspaces } = await startedApi();
  const api = apiClient(test, (await makeKey(browser, workspaces.live)).secret);
  const draft = await api.create({ text: "A draft", saveToDraft: true });

  // What the object does after every change: it reads the changes for
  // its sockets, and works out when to look next. A script that asks
  // every few seconds is not a change, and neither is a request that is
  // refused.
  const changes = vi.spyOn(WorkspaceStore.prototype, "changesSince");
  await api.ok("/posts");
  await api.ok(`/posts/${draft.id}`);
  await api.ok("/channels");
  await api.ok("/posting-schedule");
  await api.refused(
    `/posts/${draft.id}`,
    { method: "PATCH", json: { mode: "shareNow" } },
    400,
  );
  expect(changes).not.toHaveBeenCalled();

  await api.ok(`/posts/${draft.id}`, {
    method: "PATCH",
    json: { text: "Changed" },
  });
  expect(changes).toHaveBeenCalledTimes(1);
});

it("tells a key that has made too many requests when to come again, and counts each key by itself", async () => {
  // A limiter of the test's own, with a limit of three: it counts as the
  // one of the platform does, by the key that it is asked about.
  const counts = new Map<string, number>();
  const rateLimiter: RateLimit = {
    limit: async ({ key }) => {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return { success: (counts.get(key) ?? 0) <= 3 };
    },
  };
  const { test, browser, workspaces } = await started({ rateLimiter });
  const first = await makeKey(browser, workspaces.live);
  const second = await makeKey(browser, workspaces.live);
  const api = apiClient(test, first.secret);

  for (let request = 0; request < 3; request += 1) await api.ok("/account");
  const limited = await api.call("/account");
  expect(limited.status).toBe(429);
  expect(limited.headers.get("Retry-After")).toBe(
    String(apiRateLimit.periodSeconds),
  );
  expect(await limited.json()).toEqual({
    error: "LimitReachedError",
    message: expect.stringContaining(String(apiRateLimit.limit)),
  });
  // A write is not carried out either.
  await api.refused(
    "/posts",
    { method: "POST", json: { text: "Too many", saveToDraft: true } },
    429,
  );

  // Another key has its own count. What is counted by is the ID of a
  // key, which is no secret, and a request without a good key is not
  // counted at all.
  await apiClient(test, second.secret).ok("/account");
  await apiClient(test, `${first.secret.slice(0, -1)}x`).refused(
    "/account",
    {},
    401,
  );
  expect([...counts]).toEqual([
    [first.apiKey.id, 5],
    [second.apiKey.id, 1],
  ]);
});

it("is limited by the limiter of the runtime, as it is configured", async () => {
  const { test, browser, workspaces } = await started();
  const api = apiClient(test, (await makeKey(browser, workspaces.live)).secret);

  // The limiter counts in periods of a minute by the clock of the
  // runtime, which the test cannot move: a period may end while the test
  // runs, and the count begins again. Twice the limit and one are more
  // than one period takes whenever it began.
  const statuses: number[] = [];
  for (let request = 0; request <= 2 * apiRateLimit.limit; request += 1) {
    statuses.push((await api.call("/account")).status);
    if (statuses.at(-1) === 429) break;
  }
  expect(statuses.at(-1)).toBe(429);
  // Not before the limit: the first requests of a key are let through.
  expect(statuses.length).toBeGreaterThan(apiRateLimit.limit);
  expect(new Set(statuses.slice(0, -1))).toEqual(new Set([200]));
});

it("answers every refusal in one shape, with the name that follows from the status", async () => {
  const { test, browser, workspaces } = await startedApi();
  const api = apiClient(test, (await makeKey(browser, workspaces.live)).secret);
  const id = "01939c2e-0000-7000-8000-000000000000";

  // `refused` holds each answer to the shape: these are the names.
  const names = [
    (await api.refused("/posts/not-an-id", {}, 404)).error,
    (await api.refused(`/posts/${id}`, {}, 404)).error,
    (await api.refused("/nothing-here", {}, 404)).error,
    (await api.refused("/posts", { method: "POST", json: {} }, 400)).error,
    (await api.refused("/posts", { method: "PUT", json: {} }, 404)).error,
  ];
  expect(names).toEqual([
    "NotFoundError",
    "NotFoundError",
    "NotFoundError",
    "InvalidInputError",
    "NotFoundError",
  ]);

  // A body that is no JSON, and one that is too large to be read.
  const text = await test.browser().fetch("/api/v1/posts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${(await makeKey(browser, workspaces.live)).secret}`,
      Origin: null,
      "Content-Type": "application/json",
    },
  });
  expect(text.status).toBe(400);
  expect(
    await api.refused(
      "/posts",
      {
        method: "POST",
        json: {
          text: "x",
          saveToDraft: true,
          padding: "x".repeat(maxApiBodyBytes),
        },
      },
      413,
    ),
  ).toMatchObject({ error: "InvalidInputError" });
  expect((await listOf(api)).posts).toEqual([]);
});

it("documents every route that there is, and has a route for everything that it documents", async () => {
  const { test } = await startedApi();
  const document = openApiDocument() as {
    paths: Record<string, Record<string, { operationId: string }>>;
  };
  const documented = Object.entries(document.paths)
    .flatMap(([path, methods]) =>
      Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
    )
    .sort();

  // The routes that the app has under /api/v1, as Hono lists them, with
  // the middleware of each route left out, and the two that describe the
  // API, which are not part of it.
  const routes = apiRoutes({} as AppDependencies).routes;
  const served = [
    ...new Set(
      routes.map(
        ({ method, path }) => `${method} ${path.replace(/:(\w+)/g, "{$1}")}`,
      ),
    ),
  ]
    .filter((route) => !["GET /openapi.json", "GET /docs"].includes(route))
    .sort();
  expect(served).toEqual(documented);
  expect(documented).toHaveLength(Object.keys(apiOperations).length);

  // Each of them answers: with a 401 for want of a key, and not with the
  // 404 of an address that nothing is at.
  for (const route of documented) {
    const [method = "", path = ""] = route.split(" ");
    const response = await test
      .browser()
      .fetch(`/api/v1${path.replace(/\{\w+\}/g, "x")}`, { method });
    expect(response.status, route).toBe(401);
  }

  // The document is served as it is made, to anybody.
  const response = await test.browser().fetch("/api/v1/openapi.json");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(JSON.parse(JSON.stringify(document)));
});

it("serves a page that describes the API and loads nothing from anywhere", async () => {
  const { test } = await startedApi();
  const response = await test.browser().fetch("/api/v1/docs");
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toContain("text/html");
  const page = await response.text();

  for (const operation of Object.values<ApiOperation>(apiOperations)) {
    expect(page).toContain(`<code>/api/v1${operation.path}</code>`);
    expect(page).toContain(operation.summary);
  }
  for (const text of [
    "Idempotency-Key",
    "pigy_test_",
    "CreatePostRequest",
    "LimitReachedError",
  ]) {
    expect(page).toContain(text);
  }
  // No script, and no address of another site in anything that a browser
  // would load or follow: only what is the app's own, and places in the page.
  expect(page).not.toMatch(/<script|<link|<img|<iframe|@import|url\(/i);
  const addresses = [...page.matchAll(/(?:href|src)="([^"]*)"/g)].map(
    ([, address = ""]) => address,
  );
  expect(addresses.length).toBeGreaterThan(10);
  for (const address of addresses) {
    expect(address).toMatch(/^(#|\/api\/v1\/)/);
  }
});
