import {
  errorResponseSchema,
  type SandboxFaults,
  type SandboxFeed,
  sandboxFaultsSchema,
  sandboxFeedSchema,
  sandboxMastodonDomain,
} from "@pigy/core";
import { feed } from "@pigy/simulators/world";
import { expect, it } from "vitest";
import { z } from "zod";
import { connectInSandbox } from "./channels.ts";
import { type Browser, invite, signedIn } from "./helpers.ts";
import {
  connectAccount,
  ended,
  publishedOf,
  publishTo,
  started,
  targetOf,
  waitsOf,
  writeDraft,
} from "./publishing.ts";
import { SyncClient, workspaceIds } from "./sync-client.ts";

/** The feed of the sandbox of whoever `browser` is signed in as. */
async function feedOf(browser: Browser): Promise<SandboxFeed> {
  // As the app asks: with the marks and the card of each post.
  const response = await browser.fetch("/api/sandbox/feed?marks=1");
  expect(response.status).toBe(200);
  const answer = await response.json();
  const feed = sandboxFeedSchema.parse(answer);
  // The schema leaves out a field that it does not have. Nothing was
  // left out: the answer has no such field.
  expect(feed).toEqual(answer);
  return feed;
}

/** The faults of the sandbox of whoever `browser` is signed in as. */
async function faultsOf(browser: Browser): Promise<SandboxFaults> {
  const response = await browser.fetch("/api/sandbox/faults");
  expect(response.status).toBe(200);
  return sandboxFaultsSchema.parse(await response.json());
}

/** Asks for a fault to be armed, and returns the answer as it is. */
function arm(browser: Browser, fault: unknown): Promise<Response> {
  return browser.fetch("/api/sandbox/faults", { method: "POST", json: fault });
}

/** What is armed for Mastodon in the sandbox of `browser`. */
const armedFor = async (browser: Browser) =>
  (await faultsOf(browser)).networks.find(
    ({ network }) => network === "mastodon",
  )?.armed;

/** The admin with an account of their sandbox connected, and a client. */
async function inSandbox() {
  const context = await started();
  const { browser, workspaces } = context;
  const { channel = "" } = await connectInSandbox(browser, workspaces.sandbox);
  const client = new SyncClient();
  await client.connect(browser, workspaces.sandbox);
  return { ...context, workspace: workspaces.sandbox, channel, client };
}

it("lists the accounts of a new sandbox, which have posted nothing", async () => {
  const { browser } = await started();

  // Everything that a person can connect in their sandbox, before they
  // have connected anything: the page of the feeds has something to show.
  expect(await feedOf(browser)).toEqual({
    accounts: [
      // By network, then by handle.
      {
        network: "bluesky",
        id: expect.stringMatching(/^did:plc:/),
        handle: "@ada.bsky.test",
        name: "Ada Lovelace",
        posts: [],
      },
      {
        network: "bluesky",
        id: expect.stringMatching(/^did:plc:/),
        handle: "@alan.bsky.test",
        name: "Alan Turing",
        posts: [],
      },
      {
        network: "bluesky",
        id: expect.stringMatching(/^did:plc:/),
        handle: "@grace.bsky.test",
        name: "Grace Hopper",
        posts: [],
      },
      {
        network: "linkedin",
        id: expect.any(String),
        // LinkedIn addresses a member by their name.
        handle: "Ada Lovelace",
        name: "Ada Lovelace",
        posts: [],
      },
      {
        network: "linkedin",
        id: expect.any(String),
        // LinkedIn addresses a member by their name.
        handle: "Alan Turing",
        name: "Alan Turing",
        posts: [],
      },
      {
        network: "linkedin",
        id: expect.any(String),
        // LinkedIn addresses a member by their name.
        handle: "Grace Hopper",
        name: "Grace Hopper",
        posts: [],
      },
      {
        network: "mastodon",
        id: expect.any(String),
        handle: `@ada@${sandboxMastodonDomain}`,
        name: "Ada Lovelace",
        posts: [],
      },
      {
        network: "mastodon",
        id: expect.any(String),
        handle: `@alan@${sandboxMastodonDomain}`,
        name: "Alan Turing",
        posts: [],
      },
      {
        network: "mastodon",
        id: expect.any(String),
        handle: `@grace@${sandboxMastodonDomain}`,
        name: "Grace Hopper",
        posts: [],
      },
      ...["ada", "alan", "grace"].map((username, index) => ({
        network: "threads",
        id: expect.any(String),
        handle: `@${username}.sandbox`,
        name: ["Ada Lovelace", "Alan Turing", "Grace Hopper"][index],
        posts: [],
      })),
    ],
  });
});

it("shows what a sandbox has published, by account, with a thread as a chain of replies", async () => {
  const { browser, workspace, channel, client } = await inSandbox();
  const grace = await connectInSandbox(
    browser,
    workspace,
    `@grace@${sandboxMastodonDomain}`,
  );
  // The client hears of the second channel.
  await client.patch();
  const single = await writeDraft(client, workspace, "On its own");
  const thread = await writeDraft(client, workspace, "One", "Two", "Three");
  const [singleTarget = ""] = await publishTo(client, single.postId, channel);
  await ended(client, single.postId);
  const [adaTarget = "", graceTarget = ""] = await publishTo(
    client,
    thread.postId,
    channel,
    grace.channel ?? "",
  );
  await ended(client, thread.postId);

  const { accounts } = await feedOf(browser);

  const [ada, alan, hopper] = accounts.filter(
    ({ network }) => network === "mastodon",
  );
  expect(alan?.posts).toEqual([]);
  // The thread went to two accounts, and stands on each as a chain: the
  // first part at the top, and each reply beneath the part before it.
  // Plain words: nothing in them that a network shows as more than
  // text, and no link that could have a card. test/links.test.ts has the
  // posts that do.
  const plain = { entities: [], card: null, images: [] };
  const chain = (ids: string[]) => ({
    id: ids[0],
    text: "One",
    createdAt: expect.any(Number),
    ...plain,
    replies: [
      {
        id: ids[1],
        text: "Two",
        createdAt: expect.any(Number),
        ...plain,
        replies: [
          {
            id: ids[2],
            text: "Three",
            createdAt: expect.any(Number),
            ...plain,
            replies: [],
          },
        ],
      },
    ],
  });
  // The IDs are the ones that the results of the targets have, which is
  // how a page finds the post of a target in the feed.
  expect(hopper?.posts).toEqual([
    chain(publishedOf(client, graceTarget, thread)),
  ]);
  // What begins something is listed newest first.
  expect(ada?.posts).toEqual([
    chain(publishedOf(client, adaTarget, thread)),
    {
      id: publishedOf(client, singleTarget, single)[0],
      text: "On its own",
      createdAt: expect.any(Number),
      ...plain,
      replies: [],
    },
  ]);
  // An account of the feed is found among the channels by its handle.
  expect(
    client
      .table("channel")
      .map(({ handle }) => handle)
      .sort(),
  ).toEqual([ada?.handle, hopper?.handle]);
});

it("shows nobody the sandbox of another, and nothing of a live workspace", async () => {
  const context = await inSandbox();
  const { test, browser, workspaces, workspace, channel, client } = context;
  await invite(test, "member@example.com");
  const member = await signedIn(test, { email: "member@example.com" });
  // The admin publishes in their sandbox, and for real.
  const draft = await writeDraft(client, workspace, "Mine alone");
  await publishTo(client, draft.postId, channel);
  await ended(client, draft.postId);
  const live = await connectAccount(test, browser, workspaces.live);
  const liveClient = new SyncClient();
  await liveClient.connect(browser, workspaces.live);
  const real = await writeDraft(liveClient, workspaces.live, "For real");
  await publishTo(liveClient, real.postId, live);
  await ended(liveClient, real.postId);
  const texts = ({ accounts }: SandboxFeed) =>
    accounts.flatMap(({ posts }) => posts.map(({ text }) => text));

  // The routes name no workspace, so there is no address to try: each
  // person is answered for their own sandbox.
  expect(texts(await feedOf(browser))).toEqual(["Mine alone"]);
  expect(texts(await feedOf(member))).toEqual([]);
  // What was posted for real is where the real networks are, and in no
  // sandbox.
  expect(feed(test.network.world).map(({ post }) => post.text)).toEqual([
    "For real",
  ]);

  // The same for the faults: one that the admin arms strikes nothing of
  // the member's, and nothing of the admin's live workspace.
  expect(
    (await arm(browser, { network: "mastodon", kind: "server-error" })).status,
  ).toBe(200);
  expect(await armedFor(member)).toEqual([]);
  const again = await writeDraft(liveClient, workspaces.live, "Still real");
  const [target = ""] = await publishTo(liveClient, again.postId, live);
  await ended(liveClient, again.postId);
  expect(targetOf(liveClient, target).status).toBe("sent");
  expect(await armedFor(browser)).toEqual([
    { kind: "server-error", operation: null },
  ]);
});

it("answers the app from before a post had marks and a card with the feed that it takes", async () => {
  const { browser, workspace, channel, client } = await inSandbox();
  const draft = await writeDraft(
    client,
    workspace,
    "A post with a #tag",
    "And a reply",
  );
  await publishTo(client, draft.postId, channel);
  await ended(client, draft.postId);

  // The schema of a post as that app has it, written out: it refuses a
  // post with any other field, and the whole feed with it. A device goes
  // on running that app after a deploy, until it is next started there.
  type Post = { replies: Post[] };
  const post: z.ZodType<Post> = z.strictObject({
    id: z.string().min(1),
    text: z.string(),
    createdAt: z.number().int().nonnegative(),
    get replies() {
      return z.array(post);
    },
  });
  const feed = z.strictObject({
    accounts: z.array(
      z.strictObject({
        network: z.string(),
        id: z.string(),
        handle: z.string(),
        name: z.string(),
        posts: z.array(post),
      }),
    ),
  });
  // And its request, which has no query.
  const answer = await (await browser.fetch("/api/sandbox/feed")).json();
  const read = feed.parse(answer);
  // The post is in it, with its reply: the test is about a feed that is
  // not empty.
  const posts = read.accounts.flatMap((account) => account.posts);
  expect(posts).toHaveLength(1);
  expect(posts[0]?.replies).toHaveLength(1);

  // The app of today asks for the marks, and gets them.
  const [marked] = (await feedOf(browser)).accounts.flatMap(
    (account) => account.posts,
  );
  expect(marked?.entities).toEqual([{ kind: "hashtag", start: 14, end: 18 }]);
});

it("refuses somebody who is not signed in, and a request from another site", async () => {
  const { test, browser } = await started();

  for (const path of ["/api/sandbox/feed", "/api/sandbox/faults"]) {
    expect((await test.browser().fetch(path)).status).toBe(401);
  }
  // A page of another site can make the browser of somebody who is signed
  // in send this. It carries their cookie, and the origin of that site.
  const forged = await browser.fetch("/api/sandbox/faults", {
    method: "POST",
    json: { network: "mastodon", kind: "rate-limit" },
    headers: { Origin: "https://elsewhere.example" },
  });
  expect(forged.status).toBe(403);
  expect(await armedFor(browser)).toEqual([]);
});

it("says how each simulated network can be made to fail", async () => {
  const { browser } = await started();

  // What a panel offers to choose from: the kinds of failure and the kinds
  // of request, as the simulator of each network declares them.
  expect(await faultsOf(browser)).toEqual({
    networks: [
      {
        network: "bluesky",
        kinds: [
          "rate-limit",
          "server-error",
          "lost-response",
          "token-revoked",
          "token-expired",
        ],
        operations: [
          "identity",
          "server",
          "authorize",
          "token",
          "revoke",
          "profile",
          "publish",
          "read",
          "delete",
          "stats",
        ],
        armed: [],
      },
      {
        network: "linkedin",
        kinds: ["rate-limit", "server-error", "lost-response", "token-revoked"],
        operations: ["publish", "account", "token", "delete", "revoke"],
        armed: [],
      },
      {
        network: "mastodon",
        kinds: ["rate-limit", "server-error", "lost-response", "token-revoked"],
        operations: ["instance", "account", "publish", "read", "delete"],
        armed: [],
      },
      {
        network: "threads",
        kinds: [
          "rate-limit",
          "server-error",
          "lost-response",
          "token-revoked",
          "slow-processing",
        ],
        operations: [
          "publish",
          "container",
          "read",
          "account",
          "token",
          "exchange",
          "refresh",
          "delete",
          "stats",
        ],
        armed: [],
      },
    ],
  });
});

it("makes the next request of a kind fail in the sandbox, once", async () => {
  const context = await inSandbox();
  const { test, browser, workspace, channel, client } = context;

  const armed = await arm(browser, {
    network: "mastodon",
    kind: "rate-limit",
    operation: "publish",
  });

  // The answer is the faults as they are now, for the panel to show.
  expect(armed.status).toBe(200);
  expect(
    sandboxFaultsSchema
      .parse(await armed.json())
      .networks.find(({ network }) => network === "mastodon")?.armed,
  ).toEqual([{ kind: "rate-limit", operation: "publish" }]);

  const draft = await writeDraft(client, workspace, "Limited");
  const [targetId = ""] = await publishTo(client, draft.postId, channel);
  expect(await ended(client, draft.postId)).toMatchObject({ status: "sent" });

  // The simulated server refused the request to post, as the real one
  // does, and the workflow waited for as long as it said: the same
  // pipeline as for a real network, on the world of the sandbox.
  expect(await waitsOf(workspace, targetId)).toEqual({
    "publish-2-wait-1": 300,
  });
  expect(targetOf(client, targetId)).toMatchObject({
    status: "sent",
    attempt: 1,
  });
  // The fault struck once, and is gone.
  expect(await armedFor(browser)).toEqual([]);
  expect(test.network.requests).toEqual([]);
});

it("fails a post in the sandbox the way an armed fault says", async () => {
  const { browser, workspace, channel, client } = await inSandbox();
  await arm(browser, { network: "mastodon", kind: "token-revoked" });

  const draft = await writeDraft(client, workspace, "Locked out");
  const [targetId = ""] = await publishTo(client, draft.postId, channel);
  expect(await ended(client, draft.postId)).toMatchObject({ status: "error" });

  // What a person tries the failure panel for: the target says why, and
  // the channel asks to be connected again.
  expect(targetOf(client, targetId)).toMatchObject({
    status: "error",
    error: `${sandboxMastodonDomain} no longer accepts the access that pigy was given to this account.`,
  });
  expect(client.table("channel")[0]?.status).toBe("needs_reconnect");
  expect(
    (await feedOf(browser)).accounts.flatMap(({ posts }) => posts),
  ).toEqual([]);
});

it("arms faults in the order in which they were asked for, and disarms them all", async () => {
  const { browser } = await started();
  await arm(browser, { network: "mastodon", kind: "server-error" });
  await arm(browser, {
    network: "mastodon",
    kind: "lost-response",
    operation: "publish",
  });

  expect(await armedFor(browser)).toEqual([
    { kind: "server-error", operation: null },
    { kind: "lost-response", operation: "publish" },
  ]);

  const disarmed = await browser.fetch("/api/sandbox/faults", {
    method: "DELETE",
  });

  expect(disarmed.status).toBe(200);
  expect(
    sandboxFaultsSchema.parse(await disarmed.json()).networks[0]?.armed,
  ).toEqual([]);
  expect(await armedFor(browser)).toEqual([]);
});

it.each([
  // What a panel sends is what the simulators declare. Anything else is
  // refused with the field that it is about, and arms nothing.
  [
    "a failure that the network does not have",
    { network: "mastodon", kind: "meteor-strike" },
    "kind",
  ],
  [
    "a request that the network does not have",
    { network: "mastodon", kind: "rate-limit", operation: "telepathy" },
    "operation",
  ],
  [
    "a network that pigy does not know",
    { network: "myspace", kind: "x" },
    "network",
  ],
  ["no kind", { network: "mastodon" }, "kind"],
])("refuses to arm %s", async (_name, fault, field) => {
  const { browser } = await started();

  const response = await arm(browser, fault);

  expect(response.status).toBe(400);
  expect(errorResponseSchema.parse(await response.json())).toMatchObject({
    error: "InvalidInputError",
    field,
  });
  expect(await armedFor(browser)).toEqual([]);
});

it("answers for the sandbox of the caller, whatever workspace a request names", async () => {
  const { test, browser } = await started();
  await invite(test, "member@example.com");
  const member = await signedIn(test, { email: "member@example.com" });
  const { sandbox: theirs } = await workspaceIds(member);

  // No part of a request chooses the world. A caller who names the sandbox
  // of somebody else, wherever a request has room for it, arms a fault in
  // their own, or is refused.
  const named = await browser.fetch(`/api/sandbox/faults?workspace=${theirs}`, {
    method: "POST",
    json: { network: "mastodon", kind: "server-error" },
  });
  expect(named.status).toBe(200);
  const inBody = await arm(browser, {
    network: "mastodon",
    kind: "server-error",
    workspace: theirs,
  });
  expect(inBody.status).toBe(400);
  expect((await browser.fetch(`/api/sandbox/${theirs}/feed`)).status).toBe(404);

  expect(await armedFor(member)).toEqual([]);
  expect(await armedFor(browser)).toEqual([
    { kind: "server-error", operation: null },
  ]);
});
