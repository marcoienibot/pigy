import {
  evictDurableObject,
  introspectWorkflow,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Fetch } from "@pigy/core";
import { feed } from "@pigy/simulators/world";
import { expect, it, onTestFinished, vi } from "vitest";
import { lostTrackMessage } from "../src/publish/delivery.ts";
import { WorkspaceStore } from "../src/workspace/store.ts";
import {
  mutateWorkspace,
  recordProgress,
} from "../src/workspace/workspaces.ts";
import { channelsOf, disconnected, storedAccess } from "./channels.ts";
import {
  adminEmail,
  entriesOf,
  expectErrors,
  expectWarnings,
  logged,
  realMastodonDomain,
  saidBy,
  setup,
  signedIn,
} from "./helpers.ts";
import {
  connectAccount,
  ended,
  eventsOf,
  follow,
  gate,
  inPlaceOfPosting,
  patience,
  postOf,
  postStatus,
  publishedOf,
  publishTo,
  retry,
  runIdOf,
  runOf,
  started,
  stopWatching,
  storedProgress,
  targetOf,
  waiting,
  waitsOf,
  writeDraft,
} from "./publishing.ts";
import {
  identityOf,
  newId,
  objectOf,
  SyncClient,
  workspaceIds,
} from "./sync-client.ts";

/** A live workspace with one connected account and a client that follows it. */
async function ready(options: Parameters<typeof started>[0] = {}) {
  const context = await started(options);
  const { test, browser, workspaces } = context;
  const channel = await connectAccount(test, browser, workspaces.live);
  const client = new SyncClient();
  await client.connect(browser, workspaces.live);
  const posts = () => feed(test.network.world).map(({ post }) => post);
  /** How often the app has asked the server to post a status. */
  const posted = () =>
    test.network.requests.filter((request) => request === postStatus).length;
  return {
    ...context,
    workspace: workspaces.live,
    channel,
    client,
    posts,
    posted,
  };
}

/** A gate that holds the request that posts the `nth` status, and on. */
function beforePost(nth: number) {
  let count = 0;
  return gate((request) => request === postStatus && ++count >= nth);
}

it("goes on after the parts that are published when a delivery is tried again", async () => {
  let asked = 0;
  const context = await ready({
    // The server refuses the second status that it is asked to post.
    interceptNetwork: inPlaceOfPosting(
      () => ++asked === 2,
      async () => Response.json({ error: "Not this one" }, { status: 422 }),
    ),
  });
  const { workspace, channel, client, posts, posted } = context;
  const thread = await writeDraft(client, workspace, "One", "Two", "Three");

  const [targetId = ""] = await publishTo(client, thread.postId, channel);
  expect(await ended(client, thread.postId)).toMatchObject({ status: "error" });

  // The thread broke off after its first part, which stays published and
  // recorded.
  expect(targetOf(client, targetId)).toMatchObject({
    status: "error",
    attempt: 1,
    error: `${realMastodonDomain} refused the request: Not this one`,
  });
  expect(publishedOf(client, targetId, thread)).toEqual([posts()[0]?.id]);

  // Another post goes to the account meanwhile. The failed delivery does
  // not hold it up: it has ended, for the queue of its channel.
  const other = await writeDraft(client, workspace, "Other");
  await publishTo(client, other.postId, channel);
  expect(await ended(client, other.postId)).toMatchObject({ status: "sent" });

  await retry(client, targetId);
  expect(await ended(client, thread.postId)).toMatchObject({ status: "sent" });

  // The second attempt sent the two parts that were missing, and not the
  // first again: five requests to post in all, one of them refused.
  expect(targetOf(client, targetId)).toMatchObject({
    status: "sent",
    attempt: 2,
    error: null,
  });
  expect(posted()).toBe(5);
  expect(posts().map(({ text }) => text)).toEqual([
    "One",
    "Other",
    "Two",
    "Three",
  ]);
  // The thread is one chain, under the part of the first attempt. What
  // went to the account in between is not part of it.
  const [one, , two, three] = posts();
  expect(two?.replyToId).toBe(one?.id);
  expect(three?.replyToId).toBe(two?.id);
  expect(publishedOf(client, targetId, thread)).toEqual([
    one?.id,
    two?.id,
    three?.id,
  ]);
});

/**
 * A network that carries out the first request to post and loses the
 * answer, and is out of reach from then on, until the test brings it back.
 */
const losingTheFirstPost = () => losingThePost(1);

/** The same for the `nth` request to post: the ones before it go through. */
function losingThePost(nth: number) {
  const network = { state: "up" as "up" | "down" };
  let posts = 0;
  const intercept =
    (reach: Fetch): Fetch =>
    async (input, init) => {
      if (network.state === "down") throw new TypeError("The network is down");
      const response = await reach(input, init);
      if (
        init?.method === "POST" &&
        String(input) === statuses &&
        ++posts === nth
      ) {
        network.state = "down";
        throw new TypeError("The answer was lost");
      }
      return response;
    };
  return { network, intercept };
}

const statuses = `https://${realMastodonDomain}/api/v1/statuses`;

/** What a workspace keeps of how far a target has come, besides its row. */
async function progressOf(workspace: string, targetId: string) {
  const targets = await storedProgress(workspace);
  return targets.find((target) => target.id === targetId)?.progress;
}

it("finds a first part whose answer was lost when the delivery is tried again", async () => {
  const { network, intercept } = losingTheFirstPost();
  const context = await ready({ interceptNetwork: intercept });
  const { workspace, channel, client, posts, posted } = context;
  const draft = await writeDraft(client, workspace, "Lost", "Its reply");

  const [targetId = ""] = await publishTo(client, draft.postId, channel);
  await ended(client, draft.postId);

  // The part is on the network, and pigy does not know: it gave up on a
  // server that it could not reach any more.
  expect(targetOf(client, targetId)).toMatchObject({ status: "error" });
  expect(publishedOf(client, targetId, draft)).toEqual([]);
  expect(posts().map(({ text }) => text)).toEqual(["Lost"]);

  network.state = "up";
  await retry(client, targetId);
  expect(await ended(client, draft.postId)).toMatchObject({ status: "sent" });

  // The second attempt went on from where the first stood when it began,
  // looked at what the account has posted since, and took the part for
  // its own. One request to post the first part, and one for its reply.
  expect(posts().map(({ text }) => text)).toEqual(["Lost", "Its reply"]);
  expect(posts()[1]?.replyToId).toBe(posts()[0]?.id);
  expect(posted()).toBe(2);
  expect(publishedOf(client, targetId, draft)).toEqual(
    posts().map(({ id }) => id),
  );
});

it("begins a delivery anew that has published nothing once another has gone to its account", async () => {
  const { network, intercept } = losingTheFirstPost();
  const context = await ready({ interceptNetwork: intercept });
  const { test, browser, workspace, channel, client, posts } = context;
  const draft = await writeDraft(client, workspace, "Same text");
  const [targetId = ""] = await publishTo(client, draft.postId, channel);
  await ended(client, draft.postId);
  expect(targetOf(client, targetId).status).toBe("error");
  // What the next attempt would go on from: where the account stood.
  expect(await progressOf(workspace, targetId)).toContain('"after"');

  // A later post goes to the account, with the same text as it happens.
  // It does not wait for the failed one to be tried again or given up:
  // a failure that nobody looks at must not block an account.
  network.state = "up";
  const later = await writeDraft(client, workspace, "Same text");
  const [laterTarget = ""] = await publishTo(client, later.postId, channel);
  expect(await ended(client, later.postId)).toMatchObject({ status: "sent" });

  // From the moment that the later delivery was about to send, the failed
  // one can no longer go on from what it recorded. It would look through
  // what the account has posted since it began, find the post of the
  // later delivery, and take it for its own first part: two posts in pigy
  // would stand for one on the network. So its progress is gone.
  expect(await progressOf(workspace, targetId)).toBeNull();

  // Hours later the person tries the failed post again.
  test.advance(2 * 60 * 60 * 1000);
  await client.connect(browser, workspace);
  await retry(client, targetId);
  expect(await ended(client, draft.postId)).toMatchObject({ status: "sent" });

  // It began anew, as a delivery that knows of nothing before it, and
  // posted. That is the price: the first attempt had got through, so the
  // text is there once more than it was asked for. Within the hour for
  // which Mastodon remembers a request, it would have answered with the
  // post of the first attempt instead.
  expect(posts().map(({ text }) => text)).toEqual([
    "Same text",
    "Same text",
    "Same text",
  ]);
  // Each post in pigy has a post of its own on the network.
  const mine = publishedOf(client, targetId, draft);
  const theirs = publishedOf(client, laterTarget, later);
  expect(mine).toEqual([posts()[2]?.id]);
  expect(theirs).toEqual([posts()[1]?.id]);
});

it("begins a delivery anew that is tried again while the one that goes before it has yet to send", async () => {
  let asked = 0;
  const context = await ready({
    // The server refuses the first status that it is asked to post.
    interceptNetwork: inPlaceOfPosting(
      () => ++asked === 1,
      async () => Response.json({ error: "Not this one" }, { status: 422 }),
    ),
  });
  const { workspace, channel, client, posts } = context;
  const draft = await writeDraft(client, workspace, "Same text");
  const [targetId = ""] = await publishTo(client, draft.postId, channel);
  await ended(client, draft.postId);
  // Nothing of it is on the network, and it has recorded where the
  // account stood: what a later attempt would look through from.
  expect(targetOf(client, targetId).status).toBe("error");
  expect(posts()).toEqual([]);
  expect(await progressOf(workspace, targetId)).toContain('"after"');

  // A second post with the same text is published, and the first is tried
  // again right behind it: in one message, as an outbox sends what was
  // done offline. Both reach the workspace before it begins either.
  const later = await writeDraft(client, workspace, "Same text");
  const laterTarget = newId();
  client.send({
    type: "mutate",
    mutations: [
      client.mutation("target.add", {
        id: laterTarget,
        postId: later.postId,
        channelId: channel,
      }),
      client.mutation("post.publish", { id: later.postId }),
      client.mutation("target.retry", { id: targetId }),
    ],
  });
  expect((await client.patch()).rejected).toEqual([]);
  // The one that failed is not failed any more when the other begins: it
  // waits its turn, behind the other, which was asked for first.
  expect(targetOf(client, targetId).status).toBe("queued");
  expect(targetOf(client, laterTarget).status).toBe("queued");

  await ended(client, later.postId);
  await ended(client, draft.postId);

  // The later post went out first. Had the other gone on from what it
  // recorded, it would have looked through what the account has posted
  // since, found that post, and taken it for its own. It began anew
  // instead, from where the account stood after the later post, and
  // posted: each post in pigy has a post of its own on the network.
  expect(targetOf(client, targetId)).toMatchObject({
    status: "sent",
    attempt: 2,
  });
  expect(posts().map(({ text }) => text)).toEqual(["Same text", "Same text"]);
  expect(publishedOf(client, laterTarget, later)).toEqual([posts()[0]?.id]);
  expect(publishedOf(client, targetId, draft)).toEqual([posts()[1]?.id]);
});

it("finds a first part that landed unseen after a delivery to its account that sent nothing", async () => {
  const { network, intercept } = losingTheFirstPost();
  const context = await ready({ interceptNetwork: intercept });
  const { test, browser, workspace, channel, client, posts, posted } = context;
  const draft = await writeDraft(client, workspace, "Lost", "Its reply");
  const [targetId = ""] = await publishTo(client, draft.postId, channel);
  await ended(client, draft.postId);
  // The first part is on the network, and pigy does not know.
  expect(targetOf(client, targetId).status).toBe("error");
  expect(publishedOf(client, targetId, draft)).toEqual([]);
  expect(posts().map(({ text }) => text)).toEqual(["Lost"]);
  network.state = "up";

  // Another post goes to the account, and ends before anything is asked
  // of the network: it has no text.
  const empty = await writeDraft(client, workspace, "  ");
  const [emptyTarget = ""] = await publishTo(client, empty.postId, channel);
  await ended(client, empty.postId);
  expect(targetOf(client, emptyTarget)).toMatchObject({
    status: "error",
    error: "The post has no text.",
  });
  // It has put nothing on the account that the failed delivery could take
  // for its own, so what that one recorded is still there.
  expect(await progressOf(workspace, targetId)).toContain('"after"');

  // Hours later, when Mastodon no longer remembers the request of the
  // first attempt: only looking can spare a second post now.
  test.advance(2 * 60 * 60 * 1000);
  await client.connect(browser, workspace);
  await retry(client, targetId);
  expect(await ended(client, draft.postId)).toMatchObject({ status: "sent" });

  // The second attempt looked from where the first one began, and found
  // the part: one request to post it, and one for its reply.
  expect(posts().map(({ text }) => text)).toEqual(["Lost", "Its reply"]);
  expect(posted()).toBe(2);
  expect(publishedOf(client, targetId, draft)).toEqual(
    posts().map(({ id }) => id),
  );
});

it("leaves what a failed delivery recorded alone when one with nothing left to send is tried again", async () => {
  // The second request to post is the one whose answer is lost.
  const { network, intercept } = losingThePost(2);
  const context = await ready({ interceptNetwork: intercept });
  const { test, browser, workflows, workspace, channel, client, posts } =
    context;
  expectErrors();
  // Every workflow of this test fails for good where it tells the
  // workspace how it ended, so each delivery is ended by the object when it
  // looks: nobody knows how far it got, and a person may try it again.
  await workflows.modifyAll(async (modifier) => {
    await modifier.mockStepError({ name: "end" }, new Error("Stopped"));
    await modifier.disableRetryDelays();
  });
  /**
   * Waits for the delivery that a target has just been put on to begin and
   * for its run to be over, and has the object look at it, which ends it.
   */
  const lookedAfter = async (targetId: string, postId: string) => {
    await follow(client, () => targetOf(client, targetId).status === "sending");
    await eventsOf(workspace, targetId);
    expect(await runDurableObjectAlarm(objectOf(workspace))).toBe(true);
    await ended(client, postId);
    expect(targetOf(client, targetId).status).toBe("uncertain");
  };

  // The first post goes out whole, and only its end is lost.
  const whole = await writeDraft(client, workspace, "Whole");
  const [wholeTarget = ""] = await publishTo(client, whole.postId, channel);
  await lookedAfter(wholeTarget, whole.postId);
  expect(publishedOf(client, wholeTarget, whole)).toHaveLength(1);

  // The first part of the second lands on the network, and pigy does not
  // know. What it recorded before it sent is how a later attempt finds it.
  const lost = await writeDraft(client, workspace, "Lost", "Its reply");
  const [lostTarget = ""] = await publishTo(client, lost.postId, channel);
  await lookedAfter(lostTarget, lost.postId);
  expect(publishedOf(client, lostTarget, lost)).toEqual([]);
  expect(posts().map(({ text }) => text)).toEqual(["Whole", "Lost"]);
  expect(await progressOf(workspace, lostTarget)).toContain('"after"');
  network.state = "up";

  // The first post is tried again. It has nothing left to send, so it puts
  // nothing on the account that the other could take for its own.
  await retry(client, wholeTarget);
  await lookedAfter(wholeTarget, whole.postId);
  // Without this, the next attempt of the second post would begin anew.
  expect(await progressOf(workspace, lostTarget)).toContain('"after"');

  // Hours later, when Mastodon no longer remembers the request of the
  // first attempt: only looking can spare a second post now.
  test.advance(2 * 60 * 60 * 1000);
  await client.connect(browser, workspace);
  await retry(client, lostTarget);
  await lookedAfter(lostTarget, lost.postId);

  // It found its first part and posted the reply: "Lost" is there once.
  expect(posts().map(({ text }) => text)).toEqual([
    "Whole",
    "Lost",
    "Its reply",
  ]);
  expect(publishedOf(client, lostTarget, lost)).toHaveLength(2);
});

it("refuses to delete a post while it is being sent, and deletes it afterwards", async () => {
  const held = beforePost(1);
  const context = await ready({ interceptNetwork: held.intercept });
  const { workspace, channel, client, posts } = context;
  const draft = await writeDraft(client, workspace, "Keep me");
  held.close();
  const [targetId = ""] = await publishTo(client, draft.postId, channel);
  await held.reached();
  await follow(client, () => targetOf(client, targetId).status === "sending");

  // A second device deletes what it still takes for a draft.
  client.mutate("post.delete", { id: draft.postId });

  // Deleted now, the post would go out all the same, and nothing in pigy
  // would know of it.
  expect((await client.patch()).rejected).toMatchObject([{ code: "sending" }]);
  held.open();
  expect(await ended(client, draft.postId)).toMatchObject({ status: "sent" });
  expect(posts()).toHaveLength(1);

  client.mutate("post.delete", { id: draft.postId });

  // Gone from pigy with everything that belonged to it. What is on the
  // network stays there.
  expect((await client.patch()).rejected).toEqual([]);
  expect(client.copy).toMatchObject({
    post: [],
    post_part: [],
    post_target: [],
    target_part_result: [],
  });
  expect(posts()).toHaveLength(1);
});

it("ends a delivery whose account is disconnected in the middle of it", async () => {
  const held = beforePost(2);
  const context = await ready({ interceptNetwork: held.intercept });
  const { browser, workflows, workspace, channel, client, posts } = context;
  const thread = await writeDraft(client, workspace, "One", "Two", "Three");
  const waiting = await writeDraft(client, workspace, "Behind it");
  held.close();
  const [targetId = ""] = await publishTo(client, thread.postId, channel);
  const [behind = ""] = await publishTo(client, waiting.postId, channel);
  await held.reached();
  await follow(
    client,
    () => publishedOf(client, targetId, thread).length === 1,
  );

  // The first part is out, the request for the second is on its way, and
  // the person disconnects the account. The access is given back.
  expect(await disconnected(browser, workspace, channel)).toBe(true);
  await follow(client, () => client.table("channel").length === 0);

  // Everything that was to go to the account has ended, in the change
  // that removed the channel: the delivery that was under way, with the
  // part it had published, and the one that waited behind it.
  const message = "The account was disconnected before the post was sent.";
  expect(targetOf(client, targetId)).toMatchObject({
    status: "error",
    error: message,
    channelId: channel,
  });
  expect(targetOf(client, behind)).toMatchObject({
    status: "error",
    error: message,
    attempt: 0,
  });
  expect(postOf(client, thread.postId).status).toBe("error");
  expect(postOf(client, waiting.postId).status).toBe("error");
  expect(publishedOf(client, targetId, thread)).toEqual([posts()[0]?.id]);

  // The workflow finds out at its next step, and stops. The request that
  // was on its way is refused: the token is gone.
  held.open();
  const [run] = await workflows.get();
  await run?.waitForStatus("complete");
  expect(posts().map(({ text }) => text)).toEqual(["One"]);
  // It has nothing to say that the workspace would take: the delivery is
  // not its own any more. The client hears nothing further.
  expect(client.unread).toBe(0);
  expect(targetOf(client, targetId).error).toBe(message);
  // What ended cannot be tried again: there is no account to send to.
  client.mutate("target.retry", { id: targetId });
  expect((await client.patch()).rejected).toMatchObject([
    { code: "not_found" },
  ]);
});

it("publishes each part once when the workflow is stopped and taken up again", async () => {
  const held = beforePost(2);
  const context = await ready({ interceptNetwork: held.intercept });
  const { workspace, channel, client, posts, posted } = context;
  const thread = await writeDraft(client, workspace, "One", "Two", "Three");
  held.close();
  const [targetId = ""] = await publishTo(client, thread.postId, channel);
  await held.reached();
  using run = await runOf(workspace, targetId);

  // The platform stops the run after the step that it is in, as it does
  // when the Worker is deployed anew or moves, and starts it again later:
  // the run begins at its beginning, with the results of the steps that
  // were recorded.
  await run.pause();
  held.open();
  await vi.waitFor(
    async () => expect((await run.status()).status).toBe("paused"),
    patience,
  );
  await run.resume();

  expect(await ended(client, thread.postId)).toMatchObject({ status: "sent" });
  // No step that had ended was run again: three parts, three requests.
  expect(posted()).toBe(3);
  expect(posts().map(({ text }) => text)).toEqual(["One", "Two", "Three"]);
  expect(publishedOf(client, targetId, thread)).toEqual(
    posts().map(({ id }) => id),
  );
});

it("publishes each part once, and records each, when a run is restarted from its first step", async () => {
  // Without `pipeline()`: this run has to stay in its wait until the test
  // has restarted it.
  const held = beforePost(2);
  const test = setup({ interceptNetwork: held.intercept });
  const workflows = await introspectWorkflow(env.PUBLISH);
  onTestFinished(() => stopWatching(workflows));
  const browser = await signedIn(test, { email: adminEmail });
  const { live: workspace } = await workspaceIds(browser);
  const channel = await connectAccount(test, browser, workspace);
  const client = new SyncClient();
  await client.connect(browser, workspace);
  const thread = await writeDraft(client, workspace, "One", "Two");
  held.close();
  const [targetId = ""] = await publishTo(client, thread.postId, channel);
  await held.reached();
  // The request for the second part is answered with 429: the run waits
  // for five minutes, with one part published and recorded.
  test.network.mastodon.arm({ kind: "rate-limit", operation: "publish" });
  held.open();
  expect(
    await waitsOf(workspace, targetId, waiting("publish-3-wait-1")),
  ).toEqual({ "publish-3-wait-1": 300 });

  // Somebody restarts the run, from the dashboard of the platform. It
  // forgets what its steps returned and takes them again from the first,
  // which asks the workspace how far the delivery has come.
  using run = await runOf(workspace, targetId);
  await run.restart();

  expect(await ended(client, thread.postId)).toMatchObject({ status: "sent" });
  const posts = feed(test.network.world).map(({ post }) => post);
  expect(posts.map(({ text }) => text)).toEqual(["One", "Two"]);
  expect(posts[1]?.replyToId).toBe(posts[0]?.id);
  // The steps of the restarted run have the names that the first ones
  // had, and say other things: its first step publishes the second part.
  // What it reports must not be taken for a repeat of the report that was
  // made under that name before.
  expect(publishedOf(client, targetId, thread)).toEqual(
    posts.map(({ id }) => id),
  );
  expect(targetOf(client, targetId)).toMatchObject({
    status: "sent",
    attempt: 1,
  });
});

it("carries a delivery on when the object of the workspace leaves memory in the middle of it", async () => {
  const held = beforePost(2);
  const context = await ready({ interceptNetwork: held.intercept });
  const { workspace, channel, client, posts } = context;
  const thread = await writeDraft(client, workspace, "One", "Two", "Three");
  held.close();
  const [targetId = ""] = await publishTo(client, thread.postId, channel);
  await held.reached();
  await follow(
    client,
    () => publishedOf(client, targetId, thread).length === 1,
  );

  // What the runtime does to an object at any time. Everything that the
  // object knows of its deliveries is in its database.
  await evictDurableObject(objectOf(workspace));
  held.open();

  // The client is still on its socket, and sees the rest go out.
  expect(await ended(client, thread.postId)).toMatchObject({ status: "sent" });
  expect(posts().map(({ text }) => text)).toEqual(["One", "Two", "Three"]);
  expect(publishedOf(client, targetId, thread)).toHaveLength(3);
});

/**
 * Makes the platform fail to create the run of a delivery, for the targets
 * that `refused` picks out: what an outage of Workflows is to a workspace.
 */
function failingToCreate(refused: (targetId: string) => boolean) {
  const create = env.PUBLISH.create.bind(env.PUBLISH);
  const failing = vi
    .spyOn(env.PUBLISH, "create")
    .mockImplementation(async (options) => {
      if (refused(options?.params?.targetId ?? "")) {
        throw new Error("Workflows is out of order");
      }
      return create(options);
    });
  onTestFinished(() => failing.mockRestore());
  return failing;
}

it("begins the deliveries to other accounts when the workflow of one cannot be created", async () => {
  const context = await ready();
  const { test, browser, workspace, channel, client, posts } = context;
  const errors = expectErrors();
  const other = "other.test";
  test.network.mastodon.addInstance(other);
  const account = test.network.mastodon.addAccount(other, "emmy", "Emmy");
  const second = await connectAccount(test, browser, workspace, {
    domain: other,
    accountId: account.id,
  });
  await client.connect(browser, workspace);
  const draft = await writeDraft(client, workspace, "Everywhere");
  // The platform does not create the run of the first delivery that the
  // workspace asks it for, and creates every other. The test makes up the
  // IDs of the targets, to know which is which before the object begins.
  const [stuck, free] = [newId(), newId()];
  const creating = failingToCreate((targetId) => targetId === stuck);

  client.send({
    type: "mutate",
    mutations: [
      client.mutation("target.add", {
        id: stuck,
        postId: draft.postId,
        channelId: channel,
      }),
      client.mutation("target.add", {
        id: free,
        postId: draft.postId,
        channelId: second,
      }),
      client.mutation("post.publish", { id: draft.postId }),
    ],
  });
  expect((await client.patch()).rejected).toEqual([]);

  // The other delivery has nothing to do with it: it went out, in the
  // same look at the deliveries, and not a minute later.
  await follow(client, () => targetOf(client, free).status === "sent");
  expect(posts().map(({ text }) => text)).toEqual(["Everywhere"]);
  // The one without a run is under way, and nothing carries it.
  expect(targetOf(client, stuck)).toMatchObject({
    status: "sending",
    attempt: 1,
  });
  expect(entriesOf(errors)).toContainEqual(
    expect.objectContaining({
      message: "The workflow of a delivery was not created",
      workspaceId: workspace,
      targetId: stuck,
    }),
  );

  // The platform is back, and the object looks after its deliveries the
  // next time, which a test does not wait a minute for.
  creating.mockRestore();
  expect(await runDurableObjectAlarm(objectOf(workspace))).toBe(true);
  expect(await ended(client, draft.postId)).toMatchObject({ status: "sent" });
  expect(targetOf(client, stuck)).toMatchObject({ status: "sent", attempt: 1 });
  expect(posts().map(({ text }) => text)).toEqual(["Everywhere", "Everywhere"]);
});

it("leaves its alarm alone at a message of a client while a workflow cannot be created", async () => {
  const context = await ready();
  const { workspace, channel, client, posts } = context;
  expectErrors();
  const creating = failingToCreate(() => true);
  /** When the object looks after its deliveries next. */
  const alarm = () =>
    runInDurableObject(objectOf(workspace), (_, state) =>
      state.storage.getAlarm(),
    );
  const draft = await writeDraft(client, workspace, "Waiting for a run");
  const [targetId = ""] = await publishTo(client, draft.postId, channel);
  await follow(client, () => targetOf(client, targetId).status === "sending");
  // The object has begun the delivery and could not create its run. It
  // has set its alarm to try again: a minute from then, which is later
  // than now. Until it has, the alarm is the one that is running, or none.
  await vi.waitFor(
    async () => expect(await alarm()).toBeGreaterThan(Date.now()),
    patience,
  );
  const next = await alarm();

  // The person goes on writing: every keystroke is a message.
  const other = await writeDraft(client, workspace, "A");
  for (const text of ["An", "Ano", "Anot"]) {
    client.mutate("part.setText", { id: other.partIds[0] ?? "", text });
    await client.patch();
  }

  // None of them has anything to do with the run that is missing, and
  // none brought the alarm forward: it would have run each time, asked
  // the platform again and logged another failure.
  expect(await alarm()).toBe(next);
  expect(creating).toHaveBeenCalledTimes(1);

  // The alarm tries again when its time has come, which a test does not
  // wait for.
  creating.mockRestore();
  expect(await runDurableObjectAlarm(objectOf(workspace))).toBe(true);
  expect(await ended(client, draft.postId)).toMatchObject({ status: "sent" });
  expect(posts().map(({ text }) => text)).toEqual(["Waiting for a run"]);
});

it("finds the workflow of a delivery that it had created before it could take note of it", async () => {
  const held = beforePost(1);
  const context = await ready({ interceptNetwork: held.intercept });
  const { workflows, workspace, channel, client, posts, posted } = context;
  const errors = expectErrors();
  // The object goes away between the two things that it does for a
  // delivery that begins: it has created the workflow, and has not taken
  // note that it has.
  const noting = vi
    .spyOn(WorkspaceStore.prototype, "dispatched")
    .mockImplementationOnce(() => {
      throw new Error("The object was reset");
    });
  const creating = vi.spyOn(env.PUBLISH, "create");
  onTestFinished(() => {
    noting.mockRestore();
    creating.mockRestore();
  });
  /** The attempt of the target, and the one that it has a workflow for. */
  const noted = () =>
    runInDurableObject(objectOf(workspace), (_, state) =>
      state.storage.sql
        .exec("select attempt, dispatched from post_target")
        .toArray(),
    );
  const draft = await writeDraft(client, workspace, "Created once");
  held.close();
  const [targetId = ""] = await publishTo(client, draft.postId, channel);
  // The workflow is there and has got as far as the network, where the
  // test holds it: the delivery is still under way when the object looks
  // again.
  await held.reached();
  expect(await noted()).toEqual([{ attempt: 1, dispatched: 0 }]);

  // The alarm comes again, which a test does not wait a minute for.
  expect(await runDurableObjectAlarm(objectOf(workspace))).toBe(true);

  // The object asked for the workflow a second time, which the platform
  // refused: the ID is taken. It then found the one that is there, which
  // can only be its own, and took note of it.
  expect(creating).toHaveBeenCalledTimes(2);
  await expect(creating.mock.results[1]?.value).rejects.toThrow(
    "already_exists",
  );
  expect(await noted()).toEqual([{ attempt: 1, dispatched: 1 }]);
  // Nothing was logged but the failure that the test made: the second
  // look did not fail.
  expect(saidBy(errors)).toEqual([
    "The deliveries of a workspace were not looked after",
  ]);

  // One workflow carried the delivery, and posted once.
  held.open();
  expect(await ended(client, draft.postId)).toMatchObject({ status: "sent" });
  expect(await workflows.get()).toHaveLength(1);
  expect(posted()).toBe(1);
  expect(posts().map(({ text }) => text)).toEqual(["Created once"]);
  expect(targetOf(client, targetId)).toMatchObject({
    status: "sent",
    attempt: 1,
  });
});

it("ends a delivery whose workflow the platform no longer knows", async () => {
  const context = await ready();
  const { workflows, workspace, channel, client } = context;
  const errors = expectErrors();
  // The workflow publishes, and then fails for good where it tells the
  // workspace how it ended.
  await workflows.modifyAll(async (modifier) => {
    await modifier.mockStepError({ name: "end" }, new Error("Stopped"));
    await modifier.disableRetryDelays();
  });
  const draft = await writeDraft(client, workspace, "Forgotten");
  const [targetId = ""] = await publishTo(client, draft.postId, channel);
  await follow(client, () => publishedOf(client, targetId, draft).length === 1);
  const runId = await runIdOf(workspace, targetId);
  await eventsOf(workspace, targetId);
  // The platform keeps a run that is over for some days and deletes it
  // then. Nobody has looked at this delivery in all that time: the object
  // was not there to.
  expect(await env.PUBLISH.deleteBatch([runId])).toEqual({
    deleted: [{ id: runId }],
    errors: [],
  });
  expect(targetOf(client, targetId).status).toBe("sending");

  expect(await runDurableObjectAlarm(objectOf(workspace))).toBe(true);

  // A run that is gone is one that is over, and it has not ended its
  // delivery. Left `sending`, the target would hold up its channel for
  // good.
  await ended(client, draft.postId);
  expect(targetOf(client, targetId)).toMatchObject({
    status: "uncertain",
    error: lostTrackMessage,
  });
  expect(entriesOf(errors)).toContainEqual({
    level: "error",
    kind: "delivery",
    message: "The workflow of a delivery ended without a word",
    workspaceId: workspace,
    targetId,
  });
});

it("ends a delivery whose workflow is over when it cannot ask about another", async () => {
  const context = await ready();
  const { test, browser, workflows, workspace, channel, client } = context;
  const errors = expectErrors();
  const other = "other.test";
  test.network.mastodon.addInstance(other);
  const account = test.network.mastodon.addAccount(other, "emmy", "Emmy");
  const second = await connectAccount(test, browser, workspace, {
    domain: other,
    accountId: account.id,
  });
  await client.connect(browser, workspace);
  // Both workflows publish, and then fail for good where they tell the
  // workspace how they ended.
  await workflows.modifyAll(async (modifier) => {
    await modifier.mockStepError({ name: "end" }, new Error("Stopped"));
    await modifier.disableRetryDelays();
  });
  const draft = await writeDraft(client, workspace, "Twice");
  const targets = await publishTo(client, draft.postId, channel, second);
  await follow(client, () =>
    targets.every(
      (targetId) => targetOf(client, targetId).status === "sending",
    ),
  );
  for (const targetId of targets) await eventsOf(workspace, targetId);
  /** The statuses of the targets as the workspace has them, sorted. */
  const statuses = () =>
    runInDurableObject(objectOf(workspace), (_, state) =>
      state.storage.sql
        .exec<{ status: string }>(
          "select status from post_target order by status",
        )
        .toArray()
        .map(({ status }) => status),
    );
  expect(await statuses()).toEqual(["sending", "sending"]);

  // The platform does not answer the first question about a run, whichever
  // of the two that is about, and answers the next.
  const get = env.PUBLISH.get.bind(env.PUBLISH);
  let asked = 0;
  const failing = vi
    .spyOn(env.PUBLISH, "get")
    .mockImplementation(async (id) => {
      if (++asked === 1) throw new Error("Workflows is out of order");
      return get(id);
    });
  onTestFinished(() => failing.mockRestore());
  expect(await runDurableObjectAlarm(objectOf(workspace))).toBe(true);
  failing.mockRestore();

  // The run that it could ask about is over, and its delivery is ended:
  // the channel is free. Read from the workspace, because a client that
  // waits for the change would wait for ever where it does not come.
  expect(await statuses()).toEqual(["sending", "uncertain"]);
  expect(saidBy(errors)).toContain(
    "The workflow of a delivery could not be asked how it is",
  );

  // Nothing is known of the other one until the next look, which ends it.
  expect(await runDurableObjectAlarm(objectOf(workspace))).toBe(true);
  expect(await statuses()).toEqual(["uncertain", "uncertain"]);
  expect(await ended(client, draft.postId)).toMatchObject({ status: "error" });
});

it("changes nothing when what a delivery did is recorded a second time", async () => {
  // The network answers nothing, so that the workflow of the delivery
  // stays out of the way: the test reports in its place.
  const held = gate(() => true);
  const context = await ready({ interceptNetwork: held.intercept });
  const { test, workspace, channel, client } = context;
  const identity = await identityOf(test, workspace);
  const draft = await writeDraft(client, workspace, "One", "Two");
  held.close();
  const [targetId = ""] = await publishTo(client, draft.postId, channel);
  // The workflow has asked the workspace what to publish, and waits for
  // the network from here on.
  await held.reached();
  await follow(client, () => targetOf(client, targetId).status === "sending");
  const run = { targetId, attempt: 1 };
  const first = { id: newId(), remoteId: "111", url: null };
  /** What an adapter returns from a step that has published `parts`. */
  const progress = (parts: (typeof first)[]) => ({
    parts: parts.map(({ remoteId, url }) => ({ id: remoteId, url })),
    done: false,
    waitSeconds: 0,
    state: { noted: parts.length },
  });
  const record = (parts: (typeof first)[], key: string) =>
    recordProgress(env.WORKSPACE, identity, run, parts, progress(parts), key);
  const stored = async () =>
    (await storedProgress(workspace)).find(({ id }) => id === targetId)
      ?.progress;

  expect(await record([first], "step-2")).toEqual({ ok: true });
  await client.patch();
  const second = { id: newId(), remoteId: "112", url: null };
  expect(await record([first, second], "step-3")).toEqual({ ok: true });
  await client.patch();
  const recorded = client.table("target_part_result");
  expect(recorded.map(({ remoteId }) => remoteId).sort()).toEqual([
    "111",
    "112",
  ]);

  // The step that reported the first part is run again, or its first
  // report arrives after all, behind the one that followed it. Carried
  // out, it would put the delivery back to where it had one part: the
  // next attempt would go on from there and send the second again.
  expect(await record([first], "step-2")).toEqual({ ok: true });
  expect(await stored()).toBe(JSON.stringify(progress([first, second])));

  // A report that says the same under another name is carried out, and
  // finds nothing to add: a part keeps the result that it has.
  expect(
    await record([{ ...first, id: newId() }, second], "step-3-again"),
  ).toEqual({ ok: true });
  expect(client.table("target_part_result")).toEqual(recorded);

  // The same for the end of the delivery, twice under one key.
  const end = () =>
    mutateWorkspace(
      env.WORKSPACE,
      identity,
      "target.end",
      { id: targetId, attempt: 1, status: "sent" },
      "end",
    );
  expect(await end()).toEqual({ ok: true });
  const ending = await client.patch();
  expect(await end()).toEqual({ ok: true });
  expect(targetOf(client, targetId).status).toBe("sent");

  // None of the repeats made a change, so none was sent to the client:
  // the next patch is that of the next change, and follows the last.
  client.mutate("post.delete", { id: draft.postId });
  expect((await client.patch()).from).toBe(ending.to);
  held.open();
});

it("keeps the secrets of a channel out of the workflow, the log and the sync messages", async () => {
  const context = await ready();
  const { test, workflows, workspace, channel, client } = context;
  const errors = expectErrors();
  const warnings = expectWarnings();
  const info = vi.spyOn(console, "log").mockImplementation(() => {});
  onTestFinished(() => info.mockRestore());
  // A delivery with a failure in it, so that the paths that report one
  // are taken too: the first request to post is answered with 429.
  test.network.mastodon.arm({ kind: "rate-limit", operation: "publish" });
  const draft = await writeDraft(client, workspace, "Nothing to hide", "Two");

  const [targetId = ""] = await publishTo(client, draft.postId, channel);
  expect(await ended(client, draft.postId)).toMatchObject({ status: "sent" });

  // The secrets, from where they are: the token and the secret of pigy's
  // registration in the world that issued them, and the sealed credentials
  // in the workspace, which are kept out of everything like the secrets
  // in them.
  const [{ token = "" } = {}] = test.network.world.tokens("mastodon");
  const [{ clientSecret = "" } = {}] = test.network.world
    .table<{ clientSecret: string }>("mastodon", "app")
    .all();
  const [{ credentials: sealed = "" } = {}] = await storedAccess(workspace);
  const secrets = [token, clientSecret, sealed ?? ""];
  for (const secret of secrets) expect(secret.length).toBeGreaterThan(20);

  // Everything that the platform keeps of the run: what it was started
  // with and what each step returned. Locally the status of a run lists
  // the results of its steps, and its events have both.
  using run = await runOf(workspace, targetId);
  const events = await eventsOf(workspace, targetId);
  const [instance] = await workflows.get();
  const kept = JSON.stringify([
    await run.status(),
    events,
    await instance?.getOutput(),
  ]);
  // The run did its work, and its records say so: this is not an empty
  // text that holds no secret because it holds nothing.
  expect(kept).toContain("Nothing to hide");
  expect(kept).toContain("is limiting how often pigy may ask");
  expect(kept).toContain(targetId);
  const places = {
    "what the platform keeps of the run": kept,
    "the progress in the workspace": JSON.stringify(
      await storedProgress(workspace),
    ),
    "the messages to the client": client.received.join("\n"),
    "the log": logged([
      ...errors.mock.calls,
      ...warnings.mock.calls,
      ...info.mock.calls,
    ]),
  };
  for (const [place, text] of Object.entries(places)) {
    for (const secret of secrets) {
      expect(text.includes(secret), `A secret is in ${place}`).toBe(false);
    }
  }
  // The channel is still good: the credentials did their work unseen.
  expect((await channelsOf(context.browser, workspace))[0]?.status).toBe(
    "connected",
  );
});
