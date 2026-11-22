import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  mediaFilePath,
  originalLifetimeMs,
  sandboxFeedSchema,
  sandboxImagePath,
} from "@pigy/core";
import { feed } from "@pigy/simulators/world";
import { expect, it, onTestFinished, vi } from "vitest";
import { imagePolicy } from "../src/security-headers.ts";
import { WorkspaceStore } from "../src/workspace/store.ts";
import { apiClient, makeKey, startedApi } from "./api.ts";
import { connectBlueskyInSandbox, connectInSandbox } from "./channels.ts";
import {
  type Browser,
  entriesOf,
  expectErrors,
  invite,
  signedIn,
} from "./helpers.ts";
import {
  attach,
  createMedia,
  endedWithImages,
  factsOf,
  gpsText,
  holds,
  kept,
  look,
  photo,
  upload,
} from "./media.ts";
import {
  connectAccount,
  ended,
  publishTo,
  started,
  targetOf,
  waitsOf,
  writeDraft,
} from "./publishing.ts";
import { newId, objectOf, SyncClient } from "./sync-client.ts";

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
  const served = await browser.fetch(path);
  expect(served.status).toBe(200);
  // Kept by no cache, as nothing under /api is: the middleware of app.ts
  // says so of every answer there.
  expect(served.headers.get("Cache-Control")).toBe("no-store");
  // The policy of an image, as for an image of a workspace, and not the
  // one that the middleware gives an answer which sets none.
  expect(served.headers.get("Content-Security-Policy")).toBe(imagePolicy);
  expect(served.headers.get("X-Content-Type-Options")).toBe("nosniff");

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
  expect(await endedWithImages(client, draft.postId)).toMatchObject({
    status: "sent",
  });

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
  expect(await endedWithImages(client, second.postId)).toMatchObject({
    status: "sent",
  });
  const after = await env.MEDIA.head(`${workspaceId}/${variant}`);
  expect(after?.uploaded).toEqual(made?.uploaded);
  expect(after?.etag).toBe(made?.etag);
  expect(await sandboxPosts(browser)).toHaveLength(2);
});

it("lets go of the image of a post 30 days after it was sent everywhere, and keeps its small picture", async () => {
  const { test, browser, workspaces } = await started();
  const workspaceId = workspaces.sandbox;
  const { channel = "" } = await connectBlueskyInSandbox(browser, workspaceId);
  const client = new SyncClient();
  await client.connect(browser, workspaceId);
  const file = await photo(1600, 1200);
  const sent = await upload(browser, client, workspaceId, file);
  const kept_ = await upload(browser, client, workspaceId, await photo(64, 48));
  const post = await writeDraft(client, workspaceId, "Sent");
  await attach(client, post.partIds[0] ?? "", sent.id);
  // The other image is in a draft that stays a draft.
  const draft = await writeDraft(client, workspaceId, "Still a draft");
  await attach(client, draft.partIds[0] ?? "", kept_.id);
  await publishTo(client, post.postId, channel);
  expect(await endedWithImages(client, post.postId)).toMatchObject({
    status: "sent",
  });
  // The original, the small picture, and what was made for Bluesky.
  expect(await kept(workspaceId)).toContain(`${sent.id}/original`);
  expect(await kept(workspaceId)).toContain(
    `${sent.id}/variants/jpeg-1000000-0`,
  );
  // And the file as the device sent it, with the place where the photo
  // was taken, which the completion deletes, and leaves behind where the
  // bucket fails to delete it, twice.
  await env.MEDIA.put(`${workspaceId}/${sent.id}/upload`, file);

  // A day before the 30 are over, everything is there. The person goes
  // on using pigy meanwhile: a session lasts 30 days from its last use.
  const day = 24 * 60 * 60 * 1000;
  test.advance(originalLifetimeMs / 2);
  expect((await browser.fetch("/api/workspaces")).status).toBe(200);
  test.advance(originalLifetimeMs / 2 - day);
  expect((await browser.fetch("/api/workspaces")).status).toBe(200);
  await look(workspaceId);
  expect(await kept(workspaceId)).toContain(`${sent.id}/original`);

  test.advance(day + 1000);
  await look(workspaceId);
  // Before, the file as it was sent stayed.
  expect(await kept(workspaceId)).toEqual(
    [
      `${sent.id}/thumbnail`,
      `${kept_.id}/original`,
      `${kept_.id}/thumbnail`,
    ].sort(),
  );
  const later = new SyncClient();
  await later.connect(browser, workspaceId);
  const row = (id: string) =>
    later.table("media").find((media) => media.id === id);
  expect(row(sent.id)?.originalGoneAt).toEqual(expect.any(Number));
  expect(row(kept_.id)?.originalGoneAt).toBeNull();
  // The small picture is still served, the image itself no longer.
  expect(
    (await browser.fetch(mediaFilePath(workspaceId, sent.id, "thumbnail")))
      .status,
  ).toBe(200);
  expect(
    (await browser.fetch(mediaFilePath(workspaceId, sent.id, "original")))
      .status,
  ).toBe(404);
});

it("keeps the bytes of an image that a device puts into a draft while the alarm goes through the images", async () => {
  const { test, browser, workspaces } = await started();
  const workspaceId = workspaces.live;
  const channel = await connectAccount(test, browser, workspaceId);
  const client = new SyncClient();
  await client.connect(browser, workspaceId);
  const first = await upload(browser, client, workspaceId, await photo());
  const second = await upload(browser, client, workspaceId, await photo());
  const post = await writeDraft(client, workspaceId, "Sent");
  await attach(client, post.partIds[0] ?? "", first.id);
  await attach(client, post.partIds[0] ?? "", second.id);
  await publishTo(client, post.postId, channel);
  expect(await ended(client, post.postId)).toMatchObject({ status: "sent" });
  const draft = await writeDraft(client, workspaceId, "Again");

  // The person goes on using pigy meanwhile: a session lasts 30 days from
  // its last use.
  test.advance(originalLifetimeMs / 2);
  expect((await browser.fetch("/api/workspaces")).status).toBe(200);
  test.advance(originalLifetimeMs / 2 + 1000);
  // The alarm lists both as outlived. The device puts the second into a
  // draft while the alarm deletes the bytes of the first in the bucket:
  // the list is no longer what the images are when it comes to the
  // second.
  const listed = WorkspaceStore.prototype.mediaDue;
  const due = vi
    .spyOn(WorkspaceStore.prototype, "mediaDue")
    .mockImplementationOnce(function (this: WorkspaceStore, now) {
      const found = listed.call(this, now);
      expect(found.outlived.map(({ id }) => id).sort()).toEqual(
        [first.id, second.id].sort(),
      );
      this.mutate(
        {
          name: "media.attach",
          args: {
            id: newId(),
            partId: draft.partIds[0],
            mediaId: second.id,
            alt: "",
          },
        },
        now,
      );
      return found;
    });
  try {
    await look(workspaceId);
  } finally {
    due.mockRestore();
  }
  // The draft can go out with its image.
  expect(await kept(workspaceId)).toEqual(
    [
      `${first.id}/thumbnail`,
      `${second.id}/original`,
      `${second.id}/thumbnail`,
    ].sort(),
  );
  const later = new SyncClient();
  await later.connect(browser, workspaceId);
  expect(
    later.table("media").find(({ id }) => id === second.id)?.originalGoneAt,
  ).toBeNull();
});

it("ends a delivery as failed, and as nothing that a person has to look into, when its images cannot be made ready", async () => {
  const { test, browser, workflows, workspaces } = await started();
  const workspaceId = workspaces.live;
  const channel = await connectAccount(test, browser, workspaceId);
  const client = new SyncClient();
  await client.connect(browser, workspaceId);
  const image = await upload(browser, client, workspaceId, await photo());
  const draft = await writeDraft(client, workspaceId, "Not yet");
  await attach(client, draft.partIds[0] ?? "", image.id);
  // The bucket fails whenever the step that makes the images ready asks
  // it for one, for a reason of its own.
  const errors = expectErrors();
  const bucket = Object.getPrototypeOf(env.MEDIA) as R2Bucket;
  const head = bucket.head;
  const failing = vi.spyOn(bucket, "head").mockImplementation(function (
    this: R2Bucket,
    key,
  ) {
    if (key.endsWith("/original")) {
      return Promise.reject(
        new Error(
          "head: We encountered an internal error. Please try again. (10001)",
        ),
      );
    }
    return head.call(this, key);
  });
  onTestFinished(() => failing.mockRestore());
  // Before, the platform ran the step again on its own, after a minute,
  // which a test does not wait for.
  await workflows.modifyAll(async (modifier) => {
    await modifier.disableRetryDelays();
  });

  const [targetId = ""] = await publishTo(client, draft.postId, channel);
  // Before, the platform gave up on the step, and the object of the
  // workspace ended the delivery as `uncertain` when it next looked.
  await ended(client, draft.postId);

  // Nothing was asked of the network, so nobody has to look at the
  // account: the delivery failed, with words for the person.
  const target = targetOf(client, targetId);
  expect(target).toMatchObject({
    status: "error",
    error:
      "pigy could not make the images of this post ready to send. pigy has tried 6 times.",
  });
  expect(await waitsOf(workspaceId, target.id)).toEqual({
    "media-wait-1": 60,
    "media-wait-2": 120,
    "media-wait-3": 240,
    "media-wait-4": 480,
    "media-wait-5": 960,
  });
  expect(
    await runInDurableObject(objectOf(workspaceId), (_, state) =>
      state.storage.sql
        .exec<{ may: number }>(
          "select may_have_sent as may from post_target where id = ?",
          target.id,
        )
        .one(),
    ),
  ).toEqual({ may: 0 });
  expect(feed(test.network.world)).toEqual([]);
  // For whoever runs pigy, what failed: the bucket, in the step of the
  // images, of a delivery that the line names by its IDs.
  expect(entriesOf(errors)).toContainEqual(
    expect.objectContaining({
      kind: "media",
      message: "The images of a delivery could not be made ready",
      workspaceId,
      targetId,
      step: "media",
      error: expect.objectContaining({
        message: expect.stringContaining("internal error"),
      }),
    }),
  );
});

it("keeps the image of a post that did not arrive everywhere, for another try", async () => {
  const { test, browser, workspaces } = await started();
  const workspaceId = workspaces.live;
  const channel = await connectAccount(test, browser, workspaceId);
  const client = new SyncClient();
  await client.connect(browser, workspaceId);
  const image = await upload(browser, client, workspaceId, await photo());
  const draft = await writeDraft(client, workspaceId, "Refused");
  await attach(client, draft.partIds[0] ?? "", image.id);
  // The network takes the access back as the post goes out.
  test.network.mastodon.arm({ kind: "token-revoked", operation: "publish" });
  await publishTo(client, draft.postId, channel);
  expect(await ended(client, draft.postId)).toMatchObject({ status: "error" });

  test.advance(originalLifetimeMs * 2);
  await look(workspaceId);
  // Nothing of it went: the post can still be tried again, with its image.
  expect(await kept(workspaceId)).toEqual([
    `${image.id}/original`,
    `${image.id}/thumbnail`,
  ]);
});

it("holds a draft with images that the public API shares to what the editor holds it to", async () => {
  const { test, browser, workspaces } = await startedApi();
  const workspaceId = workspaces.live;
  const channel = await connectAccount(test, browser, workspaceId);
  const client = new SyncClient();
  await client.connect(browser, workspaceId);
  // Written in the app, because the API takes no image: one part, which
  // is an image without words, and whose description is longer than
  // Mastodon takes.
  const draft = await writeDraft(client, workspaceId, "");
  const image = await upload(browser, client, workspaceId, await photo());
  const attached = await attach(
    client,
    draft.partIds[0] ?? "",
    image.id,
    "A boat. ".repeat(250),
  );
  const { secret } = await makeKey(browser, workspaceId);
  const api = apiClient(test, secret);
  const share = {
    method: "PATCH",
    json: { channelIds: [channel], mode: "shareNow" },
  };

  // Before, the API judged the texts alone: it refused the part for
  // having no words, which the editor takes, and let the description
  // through, which the editor does not.
  expect(await api.refused(`/posts/${draft.postId}`, share, 400)).toMatchObject(
    {
      field: "text",
      message: expect.stringContaining("has a description of 2000 characters"),
    },
  );

  client.mutate("media.setAlt", { id: attached, alt: "Boats at dusk" });
  expect((await client.patch()).rejected).toEqual([]);
  expect(await api.ok(`/posts/${draft.postId}`, share)).toMatchObject({
    status: "sending",
  });
  expect(await api.ended(draft.postId)).toMatchObject({ status: "sent" });
  expect(feed(test.network.world)).toMatchObject([
    {
      post: {
        text: "",
        images: [{ alt: "Boats at dusk", width: 320, height: 240 }],
      },
    },
  ]);
});
