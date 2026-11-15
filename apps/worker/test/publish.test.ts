import { sandboxMastodonDomain } from "@pigy/core";
import { feed } from "@pigy/simulators/world";
import { expect, it } from "vitest";
import { limitsLifetimeMs } from "../src/publish/workflow.ts";
import { channelsOf, connectInSandbox, worldEntries } from "./channels.ts";
import { realMastodonDomain } from "./helpers.ts";
import {
  connectAccount,
  ended,
  follow,
  gate,
  postOf,
  publishedOf,
  publishTo,
  started,
  targetOf,
  writeDraft,
} from "./publishing.ts";
import { SyncClient } from "./sync-client.ts";

/** A status in the simulated world of a sandbox. */
type SandboxStatus = {
  id: string;
  accountId: string;
  text: string;
  replyToId: string | null;
};

const statusesOf = (workspaceId: string) =>
  worldEntries<SandboxStatus>(workspaceId, "post/mastodon/");

it("publishes a post to a simulated account in the sandbox", async () => {
  const { test, browser, workspaces } = await started();
  const { channel = "" } = await connectInSandbox(browser, workspaces.sandbox);
  const client = new SyncClient();
  await client.connect(browser, workspaces.sandbox);
  const draft = await writeDraft(client, workspaces.sandbox, "Hello, sandbox");

  const [targetId = ""] = await publishTo(client, draft.postId, channel);

  expect(await ended(client, draft.postId)).toMatchObject({ status: "sent" });
  expect(targetOf(client, targetId)).toMatchObject({
    status: "sent",
    attempt: 1,
    error: null,
    sentAt: expect.any(Number),
  });
  const statuses = await statusesOf(workspaces.sandbox);
  expect(statuses.map(({ text }) => text)).toEqual(["Hello, sandbox"]);
  // The row says where the part stands in the simulated world. It has no
  // link: no browser can open an address there.
  expect(client.table("target_part_result")).toEqual([
    {
      id: expect.any(String),
      targetId,
      partId: draft.partIds[0],
      remoteId: statuses[0]?.id,
      url: null,
    },
  ]);
  // The world of the sandbox answered everything: nothing went to where
  // the real networks are.
  expect(test.network.requests).toEqual([]);
});

it("publishes a post to a real account through the fetch of the app", async () => {
  const { test, browser, workspaces } = await started();
  const channel = await connectAccount(test, browser, workspaces.live);
  const client = new SyncClient();
  await client.connect(browser, workspaces.live);
  const draft = await writeDraft(client, workspaces.live, "Hello, world");

  const [targetId = ""] = await publishTo(client, draft.postId, channel);

  expect(await ended(client, draft.postId)).toMatchObject({ status: "sent" });
  const [entry, ...others] = feed(test.network.world);
  expect(others).toEqual([]);
  expect(entry?.post).toMatchObject({
    text: "Hello, world",
    accountId: test.network.account.id,
    replyToId: null,
  });
  // A real post has an address, and the row has the link to it.
  expect(client.table("target_part_result")).toMatchObject([
    { targetId, remoteId: entry?.post.id, url: entry?.post.url },
  ]);
  expect(entry?.post.url).toMatch(/^https:\/\//);
});

it("publishes a thread as a chain of replies, and shows it going out part by part", async () => {
  const { test, browser, workspaces } = await started();
  const channel = await connectAccount(test, browser, workspaces.live);
  const client = new SyncClient();
  await client.connect(browser, workspaces.live);
  const draft = await writeDraft(
    client,
    workspaces.live,
    "One",
    "Two",
    "Three",
  );

  const [targetId = ""] = await publishTo(client, draft.postId, channel);
  // The rows right after the person has asked: the post is on its way,
  // and its target waits for the server to begin.
  expect(postOf(client, draft.postId).status).toBe("sending");
  expect(targetOf(client, targetId)).toMatchObject({
    status: "queued",
    attempt: 0,
  });
  // What the client is told from then on, change by change: the status of
  // the target and how many of its parts are published.
  const seen: string[] = [];
  await follow(client, () => {
    const { status, attempt } = targetOf(client, targetId);
    const parts = publishedOf(client, targetId, draft).length;
    const state = `${status} ${attempt}: ${parts} of 3, post ${postOf(client, draft.postId).status}`;
    if (seen.at(-1) !== state) seen.push(state);
    return status === "sent";
  });

  // Each part shows as soon as it is on the network, not when the thread
  // is complete, and the post is over with its last target.
  expect(seen).toEqual([
    "queued 0: 0 of 3, post sending",
    "sending 1: 0 of 3, post sending",
    "sending 1: 1 of 3, post sending",
    "sending 1: 2 of 3, post sending",
    "sending 1: 3 of 3, post sending",
    "sent 1: 3 of 3, post sent",
  ]);
  const posts = feed(test.network.world).map(({ post }) => post);
  expect(posts.map(({ text }) => text)).toEqual(["One", "Two", "Three"]);
  // Each part replies to the one before it.
  expect(posts.map(({ replyToId }) => replyToId)).toEqual([
    null,
    posts[0]?.id,
    posts[1]?.id,
  ]);
  // The results name the parts in the order of the thread.
  expect(publishedOf(client, targetId, draft)).toEqual(
    posts.map(({ id }) => id),
  );
});

it("publishes a thread to several accounts, each on its own", async () => {
  const { browser, workspaces } = await started();
  const ada = await connectInSandbox(browser, workspaces.sandbox);
  const grace = await connectInSandbox(
    browser,
    workspaces.sandbox,
    `@grace@${sandboxMastodonDomain}`,
  );
  const client = new SyncClient();
  await client.connect(browser, workspaces.sandbox);
  const draft = await writeDraft(client, workspaces.sandbox, "First", "Second");

  const targetIds = await publishTo(
    client,
    draft.postId,
    ada.channel ?? "",
    grace.channel ?? "",
  );

  expect(await ended(client, draft.postId)).toMatchObject({ status: "sent" });
  const statuses = await statusesOf(workspaces.sandbox);
  const accounts = [...new Set(statuses.map(({ accountId }) => accountId))];
  expect(accounts).toHaveLength(2);
  for (const targetId of targetIds) {
    expect(targetOf(client, targetId).status).toBe("sent");
    // Every target has its own two statuses, on one account, the second
    // in reply to the first.
    const published = publishedOf(client, targetId, draft);
    const own = statuses.filter(({ id }) => published.includes(id));
    expect(own.map(({ text }) => text)).toEqual(["First", "Second"]);
    expect(own[1]?.replyToId).toBe(own[0]?.id);
    expect(new Set(own.map(({ accountId }) => accountId)).size).toBe(1);
  }
  expect(statuses).toHaveLength(4);
});

it("does not send what an account may not post, and sends it to the others", async () => {
  const { test, browser, workspaces } = await started();
  // A second server, which takes shorter posts than the first.
  const small = "small.test";
  test.network.mastodon.addInstance(small, { maxCharacters: 20 });
  const brief = test.network.mastodon.addAccount(small, "brief", "Brief");
  const roomy = await connectAccount(test, browser, workspaces.live);
  const tight = await connectAccount(test, browser, workspaces.live, {
    domain: small,
    accountId: brief.id,
  });
  const client = new SyncClient();
  await client.connect(browser, workspaces.live);
  const text = "This is longer than twenty characters.";
  const draft = await writeDraft(client, workspaces.live, text);
  const before = test.network.requests.length;

  const [fits = "", tooLong = ""] = await publishTo(
    client,
    draft.postId,
    roomy,
    tight,
  );

  // The targets ended differently, so the post is in `error`. Which of
  // them arrived, the targets say.
  expect(await ended(client, draft.postId)).toMatchObject({ status: "error" });
  expect(targetOf(client, fits)).toMatchObject({ status: "sent", error: null });
  expect(targetOf(client, tooLong)).toMatchObject({
    status: "error",
    // What `validateContent` found, for the person to act on.
    error: "The post is 38 characters long. The limit is 20.",
    sentAt: null,
  });
  expect(feed(test.network.world).map(({ post }) => post.text)).toEqual([text]);
  // The server that would have refused the post was not asked to take it.
  expect(
    test.network.requests
      .slice(before)
      .filter((request) => request.startsWith("POST")),
  ).toEqual([`POST https://${realMastodonDomain}/api/v1/statuses`]);
  // Nothing is wrong with the account.
  expect(
    (await channelsOf(browser, workspaces.live)).map(({ status }) => status),
  ).toEqual(["connected", "connected"]);
});

it("fails every target of a post without text, and sends nothing", async () => {
  const { test, browser, workspaces } = await started();
  const channel = await connectAccount(test, browser, workspaces.live);
  const client = new SyncClient();
  await client.connect(browser, workspaces.live);
  const draft = await writeDraft(client, workspaces.live, "  ");

  const [targetId = ""] = await publishTo(client, draft.postId, channel);

  expect(await ended(client, draft.postId)).toMatchObject({ status: "error" });
  expect(targetOf(client, targetId)).toMatchObject({
    status: "error",
    error: "The post has no text.",
  });
  expect(feed(test.network.world)).toEqual([]);
});

it("sends the deliveries to one account one after the other", async () => {
  // The network holds the first request that publishes until the test
  // lets it through.
  const held = gate((request) => request.startsWith("POST"));
  const { test, browser, workspaces } = await started({
    interceptNetwork: held.intercept,
  });
  const channel = await connectAccount(test, browser, workspaces.live);
  const client = new SyncClient();
  await client.connect(browser, workspaces.live);
  const first = await writeDraft(client, workspaces.live, "First", "Reply");
  const second = await writeDraft(client, workspaces.live, "Second");
  held.close();

  const [firstTarget = ""] = await publishTo(client, first.postId, channel);
  const [secondTarget = ""] = await publishTo(client, second.postId, channel);
  await held.reached();
  await follow(
    client,
    () => targetOf(client, firstTarget).status === "sending",
  );

  // The first delivery is in the middle of its first part. The second
  // waits its turn: an adapter tells its own posts from everything else on
  // the account by where the account stood when the delivery began, so two
  // that go out together cannot be told apart.
  expect(client.unread).toBe(0);
  expect(targetOf(client, secondTarget)).toMatchObject({
    status: "queued",
    attempt: 0,
  });
  expect(postOf(client, second.postId).status).toBe("sending");

  held.open();
  // What the client sees of the two targets from here on.
  const seen: string[] = [];
  await follow(client, () => {
    const state = [firstTarget, secondTarget]
      .map((id) => targetOf(client, id).status)
      .join(", ");
    if (seen.at(-1) !== state) seen.push(state);
    return state === "sent, sent";
  });

  // The second begins when the first has ended, and not a step earlier.
  expect(seen).toEqual([
    "sending, queued",
    "sent, queued",
    "sent, sending",
    "sent, sent",
  ]);
  expect(feed(test.network.world).map(({ post }) => post.text)).toEqual([
    "First",
    "Reply",
    "Second",
  ]);
  // Both posts are done.
  expect(postOf(client, first.postId).status).toBe("sent");
  expect(postOf(client, second.postId).status).toBe("sent");
});

it("does not hold a delivery back for one to another account", async () => {
  const held = gate(
    (request) =>
      request === `POST https://${realMastodonDomain}/api/v1/statuses`,
  );
  const { test, browser, workspaces } = await started({
    interceptNetwork: held.intercept,
  });
  const other = "other.test";
  test.network.mastodon.addInstance(other);
  const account = test.network.mastodon.addAccount(other, "emmy", "Emmy");
  held.close();
  const stuck = await connectAccount(test, browser, workspaces.live);
  const free = await connectAccount(test, browser, workspaces.live, {
    domain: other,
    accountId: account.id,
  });
  const client = new SyncClient();
  await client.connect(browser, workspaces.live);
  const draft = await writeDraft(client, workspaces.live, "Everywhere");

  const [slow = "", fast = ""] = await publishTo(
    client,
    draft.postId,
    stuck,
    free,
  );
  await follow(client, () => targetOf(client, fast).status === "sent");

  // One server takes its time. The post is out on the other meanwhile,
  // and stays `sending` until the slow one has answered.
  await held.reached();
  expect(targetOf(client, slow).status).toBe("sending");
  expect(postOf(client, draft.postId).status).toBe("sending");

  held.open();
  expect(await ended(client, draft.postId)).toMatchObject({ status: "sent" });
});

it("asks what an account may post again when the answer is a day old", async () => {
  const { test, browser, workspaces } = await started();
  const channel = await connectAccount(test, browser, workspaces.live);
  const client = new SyncClient();
  const instance = `GET https://${realMastodonDomain}/api/v2/instance`;
  const asked = () =>
    test.network.requests.filter((request) => request === instance).length;
  const connectedAt = test.clock.time.getTime();
  /** Publishes a post, and returns how often the server was asked about itself. */
  const publish = async (text: string) => {
    // On a new socket: the one before has run out while the clock moved.
    await client.connect(browser, workspaces.live);
    const before = asked();
    const draft = await writeDraft(client, workspaces.live, text);
    const [targetId = ""] = await publishTo(client, draft.postId, channel);
    await ended(client, draft.postId);
    return { targetId, asked: asked() - before };
  };

  // The limits are those of the connection, which is not a day ago. The
  // one question is the adapter's own, in its first step.
  test.advance(limitsLifetimeMs - 1000);
  expect((await publish("Twenty characters...")).asked).toBe(1);
  expect(client.table("channel")[0]?.limitsCheckedAt).toBe(connectedAt);

  // The server has changed its mind since, and a day has passed.
  test.network.mastodon.addInstance(realMastodonDomain, { maxCharacters: 10 });
  test.advance(1000);
  const refused = await publish("Twenty characters...");

  // The post was checked against what the server says now, and the
  // channel has that for the browser to count with.
  expect(refused.asked).toBe(1);
  expect(targetOf(client, refused.targetId)).toMatchObject({
    status: "error",
    error: "The post is 20 characters long. The limit is 10.",
  });
  const [asKept] = client.table("channel");
  expect(asKept?.limits).toEqual({
    network: "mastodon",
    maxCharacters: 10,
    charactersPerUrl: 23,
  });
  // Now, by the clock that has not moved since: a few milliseconds past
  // it, because every mutation of a workspace gets a time of its own.
  const sinceAsked = (asKept?.limitsCheckedAt ?? 0) - test.clock.time.getTime();
  expect(sinceAsked).toBeGreaterThanOrEqual(0);
  expect(sinceAsked).toBeLessThan(1000);
  expect(feed(test.network.world)).toHaveLength(1);
});
