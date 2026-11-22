import { env } from "cloudflare:workers";
import { sandboxFeedSchema, sandboxImagePath } from "@pigy/core";
import { feed } from "@pigy/simulators/world";
import { expect, it } from "vitest";
import { connectBlueskyInSandbox, connectInSandbox } from "./channels.ts";
import { type Browser, invite, signedIn } from "./helpers.ts";
import {
  attach,
  createMedia,
  factsOf,
  gpsText,
  holds,
  kept,
  photo,
  upload,
} from "./media.ts";
import {
  connectAccount,
  ended,
  publishTo,
  started,
  targetOf,
  writeDraft,
} from "./publishing.ts";
import { SyncClient } from "./sync-client.ts";

/**
 * Posts with images, published by the workflow of the Worker: to the
 * simulated world of a sandbox, and to the networks of the test, which
 * stand for the real ones.
 */

/** The posts of the sandbox of `browser`, as the Simulator screen reads them. */
async function sandboxPosts(browser: Browser) {
  const response = await browser.fetch("/api/sandbox/feed?marks=1");
  expect(response.status).toBe(200);
  const { accounts } = sandboxFeedSchema.parse(await response.json());
  return accounts.flatMap(({ network, posts }) =>
    posts.map((post) => ({ network, ...post })),
  );
}

it("publishes a post with images to a simulated Mastodon account, and the feed of the sandbox shows them", async () => {
  const { browser, workspaces } = await started();
  const workspaceId = workspaces.sandbox;
  const { channel = "" } = await connectInSandbox(browser, workspaceId);
  const client = new SyncClient();
  await client.connect(browser, workspaceId);
  const draft = await writeDraft(client, workspaceId, "A harbour");
  const first = await upload(
    browser,
    client,
    workspaceId,
    await photo(320, 240),
  );
  const second = await upload(
    browser,
    client,
    workspaceId,
    await photo(200, 300),
  );
  const [partId = ""] = draft.partIds;
  await attach(client, partId, first.id, "Boats at dusk");
  await attach(client, partId, second.id);

  const [targetId = ""] = await publishTo(client, draft.postId, channel);
  expect(await ended(client, draft.postId)).toMatchObject({ status: "sent" });
  expect(targetOf(client, targetId)).toMatchObject({ status: "sent" });

  const [post, ...more] = await sandboxPosts(browser);
  expect(more).toEqual([]);
  expect(post).toMatchObject({
    network: "mastodon",
    text: "A harbour",
    images: [
      { alt: "Boats at dusk", width: 320, height: 240 },
      { alt: "", width: 200, height: 300 },
    ],
  });

  // The bytes of the simulated network, served to the owner as an image:
  // what was published, which is the picture without what the camera
  // wrote.
  const [image] = post?.images ?? [];
  const response = await browser.fetch(sandboxImagePath(image?.id ?? ""));
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("image/jpeg");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  const published = new Uint8Array(await response.arrayBuffer());
  expect(holds(published, gpsText)).toBe(false);
  expect(await factsOf(published)).toMatchObject({ width: 320, height: 240 });
  // Mastodon takes the image as it is: nothing was made of it.
  expect(await kept(workspaceId)).toEqual(
    [first.id, second.id]
      .flatMap((id) => [`${id}/original`, `${id}/thumbnail`])
      .sort(),
  );
});

it("serves an image of a sandbox to nobody but its owner", async () => {
  const { test, browser, workspaces } = await started();
  const workspaceId = workspaces.sandbox;
  const { channel = "" } = await connectInSandbox(browser, workspaceId);
  const client = new SyncClient();
  await client.connect(browser, workspaceId);
  const draft = await writeDraft(client, workspaceId, "Mine");
  const image = await upload(browser, client, workspaceId, await photo());
  await attach(client, draft.partIds[0] ?? "", image.id);
  await publishTo(client, draft.postId, channel);
  await ended(client, draft.postId);
  const [post] = await sandboxPosts(browser);
  const path = sandboxImagePath(post?.images?.[0]?.id ?? "");
  expect((await browser.fetch(path)).status).toBe(200);

  expect((await test.browser().fetch(path)).status).toBe(401);
  // Somebody else has a sandbox of their own, whose world has no such
  // image: the name of one leads to nothing of another's.
  await invite(test, "friend@example.com");
  const friend = await signedIn(test, { email: "friend@example.com" });
  expect((await friend.fetch(path)).status).toBe(404);
  expect((await browser.fetch(sandboxImagePath("blob999"))).status).toBe(404);
});

it("publishes a thread with images to a real Mastodon account: each part with its own", async () => {
  const { test, browser, workspaces } = await started();
  const workspaceId = workspaces.live;
  const channel = await connectAccount(test, browser, workspaceId);
  const client = new SyncClient();
  await client.connect(browser, workspaceId);
  const draft = await writeDraft(client, workspaceId, "First", "", "Third");
  const [one, two, three] = [
    await upload(browser, client, workspaceId, await photo(320, 240)),
    await upload(browser, client, workspaceId, await photo(240, 320)),
    await upload(browser, client, workspaceId, await photo(400, 400)),
  ];
  // The second part is only its images.
  await attach(client, draft.partIds[1] ?? "", one.id, "One");
  await attach(client, draft.partIds[1] ?? "", two.id, "Two");
  await attach(client, draft.partIds[2] ?? "", three.id, "Three");

  await publishTo(client, draft.postId, channel);
  expect(await ended(client, draft.postId)).toMatchObject({ status: "sent" });

  expect(
    feed(test.network.world, ["mastodon"]).map(({ post }) => [
      post.text,
      (post.images ?? []).map(({ alt, width }) => [alt, width]),
    ]),
  ).toEqual([
    ["First", []],
    [
      "",
      [
        ["One", 320],
        ["Two", 240],
      ],
    ],
    ["Third", [["Three", 400]]],
  ]);
  // One upload for each image, to the network of the test and nowhere
  // else.
  expect(
    test.network.requests.filter((request) =>
      request.endsWith("/api/v2/media"),
    ),
  ).toHaveLength(3);
  // No image of the test left pigy with what the camera wrote.
  for (const { post } of feed(test.network.world, ["mastodon"])) {
    for (const { blob } of post.images ?? []) {
      const bytes = test.network.world.blobs.get(blob);
      expect(bytes && holds(bytes, gpsText)).toBe(false);
    }
  }
});

it("does not publish a post while an image of it is still on its way, and says which", async () => {
  const { test, browser, workspaces } = await started();
  const workspaceId = workspaces.live;
  const channel = await connectAccount(test, browser, workspaceId);
  const client = new SyncClient();
  await client.connect(browser, workspaceId);
  const draft = await writeDraft(client, workspaceId, "Too early");
  const mediaId = await createMedia(client, await photo());
  await attach(client, draft.partIds[0] ?? "", mediaId);

  const [targetId = ""] = await publishTo(client, draft.postId, channel);
  expect(await ended(client, draft.postId)).toMatchObject({ status: "error" });
  expect(targetOf(client, targetId)).toMatchObject({
    status: "error",
    error: "The image of the post is still being uploaded.",
  });
  expect(feed(test.network.world)).toEqual([]);
  expect(await env.MEDIA.list()).toMatchObject({ objects: [] });
});

it("makes a smaller image for Bluesky of one that is over its limit, once, and publishes that", async () => {
  const { browser, workspaces } = await started();
  const workspaceId = workspaces.sandbox;
  const { channel = "" } = await connectBlueskyInSandbox(browser, workspaceId);
  const client = new SyncClient();
  await client.connect(browser, workspaceId);
  // Noise in a JPEG of this size is far over a million bytes.
  const large = await upload(
    browser,
    client,
    workspaceId,
    await photo(1600, 1200),
  );
  expect(large.size).toBeGreaterThan(1_000_000);
  const small = await upload(browser, client, workspaceId, await photo(64, 48));

  const draft = await writeDraft(client, workspaceId, "From the harbour");
  await attach(client, draft.partIds[0] ?? "", large.id, "The harbour");
  await attach(client, draft.partIds[0] ?? "", small.id, "A detail");
  await publishTo(client, draft.postId, channel);
  expect(await ended(client, draft.postId)).toMatchObject({ status: "sent" });

  const [post] = await sandboxPosts(browser);
  expect(post).toMatchObject({
    network: "bluesky",
    text: "From the harbour",
    images: [
      { alt: "The harbour" },
      { alt: "A detail", width: 64, height: 48 },
    ],
  });
  // What Bluesky got of the large one is within its limit, is still the
  // picture in its shape, and has nothing of the camera.
  const [shown] = post?.images ?? [];
  const response = await browser.fetch(sandboxImagePath(shown?.id ?? ""));
  const published = new Uint8Array(await response.arrayBuffer());
  expect(published.length).toBeLessThanOrEqual(1_000_000);
  const facts = await factsOf(published);
  expect(facts.type).toBe("image/jpeg");
  expect(facts.width / facts.height).toBeCloseTo(1600 / 1200, 1);
  expect(shown).toMatchObject({ width: facts.width, height: facts.height });
  expect(holds(published, gpsText)).toBe(false);

  // Kept next to the original, under the name of what it was made
  // within. The small image went out as it is: nothing was made of it.
  const variant = `${large.id}/variants/jpeg-1000000-0`;
  expect(await kept(workspaceId)).toEqual(
    [
      `${large.id}/original`,
      `${large.id}/thumbnail`,
      variant,
      `${small.id}/original`,
      `${small.id}/thumbnail`,
    ].sort(),
  );

  // A second post with the same image goes out with the image that was
  // made for the first: the file in the bucket is not written again.
  const made = await env.MEDIA.head(`${workspaceId}/${variant}`);
  const second = await writeDraft(client, workspaceId, "Once more");
  await attach(client, second.partIds[0] ?? "", large.id);
  await publishTo(client, second.postId, channel);
  expect(await ended(client, second.postId)).toMatchObject({ status: "sent" });
  const after = await env.MEDIA.head(`${workspaceId}/${variant}`);
  expect(after?.uploaded).toEqual(made?.uploaded);
  expect(after?.etag).toBe(made?.etag);
  expect(await sandboxPosts(browser)).toHaveLength(2);
});
