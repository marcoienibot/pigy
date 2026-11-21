import { feed } from "@pigy/simulators/world";
import { expect, it } from "vitest";
import {
  connectBlueskyInSandbox,
  connectBlueskyLive,
  connectInSandbox,
  worldEntries,
} from "./channels.ts";
import {
  connectAccount,
  ended,
  inPlaceOfPosting,
  publishedOf,
  publishTo,
  retry,
  started,
  targetOf,
  writeDraft,
} from "./publishing.ts";
import { newId, SyncClient } from "./sync-client.ts";

/**
 * Threads that are written with the mutators of the editor, and the text
 * that one account gets in place of the post's: what a client asks for is
 * what the networks get.
 */

/** A post in the simulated world of a sandbox, of either network. */
type SandboxPost = { id: string; text: string; replyToId: string | null };

/**
 * A workspace with an account of Mastodon and one of Bluesky connected,
 * and a client that follows it.
 */
async function withBoth(where: "sandbox" | "live") {
  const context = await started();
  const { test, browser, workspaces } = context;
  const workspace = workspaces[where];
  const mastodon =
    where === "sandbox"
      ? ((await connectInSandbox(browser, workspace)).channel ?? "")
      : await connectAccount(test, browser, workspace);
  const { channel: bluesky = "" } =
    where === "sandbox"
      ? await connectBlueskyInSandbox(browser, workspace)
      : await connectBlueskyLive(test, browser, workspace);
  const client = new SyncClient();
  await client.connect(browser, workspace);
  /** The texts on a network, oldest first, each with what it replies to. */
  const on = async (network: "mastodon" | "bluesky") => {
    const posts: SandboxPost[] =
      where === "sandbox"
        ? await worldEntries<SandboxPost>(workspace, `post/${network}/`)
        : feed(test.network.world, [network]).map(({ post }) => post);
    return posts;
  };
  return { ...context, workspace, mastodon, bluesky, client, on };
}

/** Sends one mutation and applies its patch, which must reject nothing. */
async function mutated(
  client: SyncClient,
  ...[name, args]: Parameters<SyncClient["mutate"]>
) {
  client.mutate(name, args);
  expect((await client.patch()).rejected).toEqual([]);
}

/**
 * Chooses channels for a draft, as `publishTo` does, without publishing
 * it: a text for one account can only be written for a draft.
 */
async function choose(
  client: SyncClient,
  postId: string,
  ...channelIds: string[]
): Promise<string[]> {
  const targetIds = channelIds.map(() => newId());
  for (const [index, channelId] of channelIds.entries()) {
    await mutated(client, "target.add", {
      id: targetIds[index] ?? "",
      postId,
      channelId,
    });
  }
  return targetIds;
}

it("publishes a thread in the order that the editor left it in", async () => {
  const { test, browser, workspaces } = await started();
  const channel = await connectAccount(test, browser, workspaces.live);
  const client = new SyncClient();
  await client.connect(browser, workspaces.live);
  const draft = await writeDraft(client, workspaces.live, "One", "Four");
  const [one = "", four = ""] = draft.partIds;
  const [two, three, stray] = [newId(), newId(), newId()];

  // What a person does in the editor: a part in the middle, one at the
  // wrong place that is then moved, and one that is removed again.
  const add = (id: string, afterId: string | null, text: string) =>
    mutated(client, "part.add", {
      id,
      postId: draft.postId,
      channelId: null,
      afterId,
      text,
    });
  await add(three, one, "Three");
  await add(two, four, "Two");
  await add(stray, null, "Not this one");
  await mutated(client, "part.move", { id: two, afterId: one });
  await mutated(client, "part.remove", { id: stray });

  const [targetId = ""] = await publishTo(client, draft.postId, channel);
  expect(await ended(client, draft.postId)).toMatchObject({ status: "sent" });

  // One chain of replies, in the order of the parts and not in the order
  // in which they were written.
  const posts = feed(test.network.world).map(({ post }) => post);
  expect(posts.map(({ text }) => text)).toEqual([
    "One",
    "Two",
    "Three",
    "Four",
  ]);
  expect(posts.map(({ replyToId }) => replyToId)).toEqual([
    null,
    posts[0]?.id,
    posts[1]?.id,
    posts[2]?.id,
  ]);
  expect(
    publishedOf(client, targetId, {
      postId: draft.postId,
      partIds: [one, two, three, four],
    }),
  ).toEqual(posts.map(({ id }) => id));
});

it.each(["sandbox", "live"] as const)(
  "publishes the text that is written for one account there, and the post's to the other, in the %s workspace",
  async (where) => {
    const { test, workspace, mastodon, bluesky, client, on } =
      await withBoth(where);
    const draft = await writeDraft(client, workspace, "One", "Two");
    const [toMastodon = "", toBluesky = ""] = await choose(
      client,
      draft.postId,
      mastodon,
      bluesky,
    );
    // Bluesky gets a thread of its own, with another number of parts.
    const own = [newId(), newId(), newId()];
    await mutated(client, "target.customize", {
      postId: draft.postId,
      channelId: bluesky,
      parts: [
        { id: own[0] ?? "", text: "One, for Bluesky" },
        { id: own[1] ?? "", text: "Two, for Bluesky" },
        { id: own[2] ?? "", text: "Three, for Bluesky" },
      ],
    });
    // It is edited like the post's text, by the same mutators.
    await mutated(client, "part.setText", {
      id: own[1] ?? "",
      text: "Two, for Bluesky, edited",
    });

    await mutated(client, "post.publish", { id: draft.postId });
    expect(await ended(client, draft.postId)).toMatchObject({ status: "sent" });

    const onMastodon = await on("mastodon");
    expect(onMastodon.map(({ text }) => text)).toEqual(["One", "Two"]);
    expect(onMastodon[1]?.replyToId).toBe(onMastodon[0]?.id);
    // The results of Bluesky name the parts that were written for it, in
    // their order: the posts are sorted by them, since a world lists the
    // posts of Bluesky in no order that a test could count on.
    const ids = publishedOf(client, toBluesky, {
      postId: draft.postId,
      partIds: own,
    });
    expect(ids).toHaveLength(3);
    const onBluesky = [...(await on("bluesky"))].sort(
      (a, b) => ids.indexOf(a.id) - ids.indexOf(b.id),
    );
    expect(onBluesky).toMatchObject([
      { id: ids[0], text: "One, for Bluesky", replyToId: null },
      { id: ids[1], text: "Two, for Bluesky, edited", replyToId: ids[0] },
      { id: ids[2], text: "Three, for Bluesky", replyToId: ids[1] },
    ]);
    // And those of Mastodon the post's own.
    expect(publishedOf(client, toMastodon, draft)).toEqual(
      onMastodon.map(({ id }) => id),
    );
    if (where === "sandbox") expect(test.network.requests).toEqual([]);
  },
);

it("goes on with the text that was written for the account when its delivery is tried again", async () => {
  let asked = 0;
  const context = await started({
    // The server refuses the second status that it is asked to post.
    interceptNetwork: inPlaceOfPosting(
      () => ++asked === 2,
      async () => Response.json({ error: "Not this one" }, { status: 422 }),
    ),
  });
  const { test, browser, workspaces } = context;
  const channel = await connectAccount(test, browser, workspaces.live);
  const client = new SyncClient();
  await client.connect(browser, workspaces.live);
  const draft = await writeDraft(client, workspaces.live, "The post's text");
  const [targetId = ""] = await choose(client, draft.postId, channel);
  const own = [newId(), newId()];
  await mutated(client, "target.customize", {
    postId: draft.postId,
    channelId: channel,
    parts: [
      { id: own[0] ?? "", text: "Own one" },
      { id: own[1] ?? "", text: "Own two" },
    ],
  });
  await mutated(client, "post.publish", { id: draft.postId });
  expect(await ended(client, draft.postId)).toMatchObject({ status: "error" });
  expect(targetOf(client, targetId).status).toBe("error");

  // Between the attempts, nothing of what the account gets can change: a
  // retry looks on the network for what the attempt before sent, and
  // goes on from there with the rest of the same text.
  const refused = async (...mutation: Parameters<SyncClient["mutate"]>) => {
    client.mutate(...mutation);
    return (await client.patch()).rejected.map(({ code }) => code);
  };
  expect(
    await refused("part.setText", { id: own[1] ?? "", text: "Changed" }),
  ).toEqual(["not_a_draft"]);
  expect(
    await refused("target.followPost", {
      postId: draft.postId,
      channelId: channel,
    }),
  ).toEqual(["not_a_draft"]);

  await retry(client, targetId);
  expect(await ended(client, draft.postId)).toMatchObject({ status: "sent" });

  // The second attempt sent the part that was missing, of the account's
  // own text, as a reply to the first. The post's own text went nowhere.
  const posts = feed(test.network.world).map(({ post }) => post);
  expect(posts.map(({ text }) => text)).toEqual(["Own one", "Own two"]);
  expect(posts[1]?.replyToId).toBe(posts[0]?.id);
  expect(
    publishedOf(client, targetId, { postId: draft.postId, partIds: own }),
  ).toEqual(posts.map(({ id }) => id));
});
