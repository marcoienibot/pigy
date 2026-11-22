import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type Environment,
  type Fetch,
  maxImageBytes,
  maxWorkspaceMediaBytes,
  sandboxFeedSchema,
  sandboxImage,
  uploadRequestsPerMinute,
} from "@pigy/core";
import { type ApiPost, apiMediaSchema, apiPostSchema } from "@pigy/core/api";
import { pngFile } from "@pigy/core/test-images";
import { webImages } from "@pigy/simulators/web";
import { feed } from "@pigy/simulators/world";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vitest";
import { uploadUses } from "../src/db/schema.ts";
import { type ApiClient, apiClient, makeKey, startedApi } from "./api.ts";
import { connectInSandbox, connectLinkedInInSandbox } from "./channels.ts";
import { type Browser, type TestSetup, urlOf } from "./helpers.ts";
import { gpsText, holds, kept, photo, served } from "./media.ts";
import { connectAccount, patience } from "./publishing.ts";
import { objectOf, SyncClient } from "./sync-client.ts";

/**
 * Images through the public API: a file that a script uploads with
 * `POST /media`, and the images that a post names in `assets`, by the ID
 * of such an upload or by an address, which the Worker fetches. With a
 * key of a live workspace, which reaches what stands for the internet in
 * these tests, `test.network`, and with one of a sandbox, which reaches
 * its simulated web alone.
 */

/** A workspace with a Mastodon account connected, and a key for it. */
async function ready(
  environment: Environment,
  options: Parameters<typeof startedApi>[0] = {},
) {
  const context = await startedApi(options);
  const { test, browser, workspaces } = context;
  const workspace = workspaces[environment];
  const channel =
    environment === "live"
      ? await connectAccount(test, browser, workspace)
      : ((await connectInSandbox(browser, workspace)).channel ?? "");
  const { secret } = await makeKey(browser, workspace);
  return {
    ...context,
    workspace,
    channel,
    secret,
    api: apiClient(test, secret),
  };
}

/** Uploads `file` with `POST /media`. */
const upload = (
  api: ApiClient,
  file: Uint8Array,
  headers: Record<string, string | null> = {},
) =>
  api.call("/media", {
    method: "POST",
    body: file,
    headers: { "Content-Type": "image/jpeg", ...headers },
  } as Parameters<ApiClient["call"]>[1]);

/** The images that the network of `environment` was sent, in order. */
async function publishedImages(
  { test, browser }: { test: TestSetup; browser: Browser },
  environment: Environment,
): Promise<
  {
    alt: string;
    width: number;
    height: number;
    bytes?: Uint8Array | undefined;
  }[]
> {
  if (environment === "live") {
    return feed(test.network.world).flatMap(({ post }) =>
      (post.images ?? []).map(({ alt, width, height, blob }) => ({
        alt,
        width,
        height,
        ...(test.network.world.blobs.get(blob) && {
          bytes: test.network.world.blobs.get(blob),
        }),
      })),
    );
  }
  const response = await browser.fetch("/api/sandbox/feed?marks=1");
  const { accounts } = sandboxFeedSchema.parse(await response.json());
  return accounts.flatMap(({ posts }) =>
    posts.flatMap((post) =>
      (post.images ?? []).map(({ alt, width, height }) => ({
        alt,
        width,
        height,
      })),
    ),
  );
}

/** What the copy of a client of the app has of images, after a patch. */
async function rowsOf(browser: Browser, workspace: string) {
  const client = new SyncClient();
  await client.connect(browser, workspace);
  return {
    media: [...client.copy.media.values()],
    partMedia: [...client.copy.part_media.values()],
  };
}

/** The requests that went to what stands for the internet, by address. */
const asked = (test: TestSetup, host: string) =>
  test.network.requests.filter((request) => request.includes(`//${host}/`));

describe.each(["live", "sandbox"] as const)(
  "with a key of a %s workspace",
  (environment) => {
    it("takes an uploaded file in without what a camera wrote, and publishes it in a post that names it by its ID", async () => {
      const context = await ready(environment);
      const { browser, workspace, channel, api } = context;
      const file = await photo(320, 240);
      expect(holds(file, gpsText)).toBe(true);

      const response = await upload(api, file);
      expect(response.status).toBe(201);
      const media = apiMediaSchema.parse(await response.json());
      expect(media).toMatchObject({
        status: "ready",
        type: "image/jpeg",
        width: 320,
        height: 240,
        animated: false,
      });
      // The copy is kept, with its small picture, and the file as it came
      // goes once the row is there.
      await vi.waitFor(async () => {
        expect(await kept(workspace)).toEqual([
          `${media.id}/original`,
          `${media.id}/thumbnail`,
        ]);
      }, patience);
      const copy = await served(browser, workspace, media.id);
      expect(copy.byteLength).toBe(media.size);
      expect(holds(copy, gpsText)).toBe(false);

      const post = await api.create({
        text: "A harbour",
        channelIds: [channel],
        mode: "shareNow",
        assets: [
          {
            image: { mediaId: media.id, metadata: { altText: "Boats" } },
          },
        ],
      });
      expect(post.assets).toEqual([
        {
          image: {
            mediaId: media.id,
            status: "ready",
            metadata: { altText: "Boats" },
          },
        },
      ]);
      expect(await api.ended(post.id)).toMatchObject({ status: "sent" });
      const images = await publishedImages(context, environment);
      expect(images).toMatchObject([{ alt: "Boats", width: 320, height: 240 }]);
      if (environment === "live") {
        expect(holds(images[0]?.bytes as Uint8Array, gpsText)).toBe(false);
      }
    });

    it("fetches the images at the addresses that a post names, once each, and the app has them as it has its own", async () => {
      const { test, browser, workspace, api } = await ready(environment);
      const post = await api.create({
        text: "Evening",
        saveToDraft: true,
        assets: [
          { image: { url: sandboxImage, metadata: { altText: "Sunset" } } },
        ],
        metadata: {
          thread: [
            // One that sends pigy on to the image, and one whose answer
            // says that it is text: what a file is, its bytes say.
            { text: "Moved", assets: [{ image: { url: webImages.moved } }] },
            {
              text: "Mislabelled",
              assets: [
                { image: { url: webImages.mislabelled } },
                // The same address again: one image for both.
                { image: { url: sandboxImage } },
              ],
            },
          ],
        },
      });
      const [first] = post.assets;
      const [moved, mislabelled] = post.metadata.thread;
      expect(first).toMatchObject({
        image: { status: "ready", metadata: { altText: "Sunset" } },
      });
      expect(moved?.assets).toMatchObject([{ image: { status: "ready" } }]);
      expect(mislabelled?.assets).toMatchObject([
        { image: { status: "ready", metadata: { altText: "" } } },
        { image: { mediaId: first?.image.mediaId } },
      ]);
      expect(await api.post(post.id)).toEqual(post);
      if (environment === "live") {
        // A few at a time, in no order: the image that the address that
        // moved leads to is asked twice, and the one named twice once.
        expect(asked(test, "example.test").sort()).toEqual(
          [
            `GET ${sandboxImage}`,
            `GET ${webImages.moved}`,
            `GET ${sandboxImage}`,
            `GET ${webImages.mislabelled}`,
          ].sort(),
        );
      } else {
        // A sandbox asks its simulated world, and nothing of the internet.
        expect(asked(test, "example.test")).toEqual([]);
      }

      // The app has three images, ready, the way it has its own: in the
      // parts, with what the server read in their bytes.
      const { media, partMedia } = await rowsOf(browser, workspace);
      expect(media).toHaveLength(3);
      for (const row of media) {
        expect(row).toMatchObject({
          status: "ready",
          type: "image/png",
          width: 120,
          height: 80,
        });
      }
      expect(partMedia).toHaveLength(4);
    });

    it("refuses an address whose answer is no image, and keeps nothing of the request", async () => {
      const { test, browser, workspace, api } = await ready(environment);
      const refused = await api.refused(
        "/posts",
        {
          method: "POST",
          json: {
            text: "Not one",
            saveToDraft: true,
            assets: [
              { image: { url: sandboxImage } },
              { image: { url: webImages.notAnImage } },
            ],
          },
        },
        400,
      );
      expect(refused).toMatchObject({
        field: "assets.1.image.url",
        message: expect.stringMatching(/^assets\.1\.image\.url: /),
      });
      // Nothing was made, and what was fetched is gone from the bucket.
      expect(await api.ok("/posts")).toMatchObject({ posts: [] });
      expect(await rowsOf(browser, workspace)).toEqual({
        media: [],
        partMedia: [],
      });
      expect(await kept(workspace)).toEqual([]);
      if (environment === "live") {
        expect(asked(test, "example.test")).toHaveLength(2);
      }
    });

    it("asks nothing at an address that pigy does not ask", async () => {
      const { test, api } = await ready(environment);
      const before = test.network.requests.length;
      for (const url of [
        "http://example.test/images/sunset.png",
        "https://localhost/a.png",
        "https://192.168.1.1/a.png",
        "https://example.test:8443/a.png",
      ]) {
        expect(
          await api.refused(
            "/posts",
            {
              method: "POST",
              json: {
                text: "x",
                saveToDraft: true,
                metadata: {
                  thread: [{ text: "y", assets: [{ image: { url } }] }],
                },
              },
            },
            400,
          ),
          url,
        ).toMatchObject({
          field: "metadata.thread.0.assets.0.image.url",
          message: expect.stringContaining("HTTPS address of a public host"),
        });
      }
      expect(test.network.requests.slice(before)).toEqual([]);
    });

    it("refuses a file that is no image, and one that is too large, and keeps nothing of either", async () => {
      const { test, workspace, api, secret } = await ready(environment);
      const text = await upload(api, new TextEncoder().encode("Hello"));
      expect(text.status).toBe(400);
      expect(await text.json()).toMatchObject({ error: "InvalidInputError" });
      const empty = await upload(api, new Uint8Array(0));
      expect(empty.status).toBe(400);

      // By the length that the request declares, before it is read.
      const declared = await upload(api, new Uint8Array(16), {
        "Content-Length": String(maxImageBytes + 1),
      });
      expect(declared.status).toBe(413);
      // And by what comes, for a request that declares nothing.
      let sent = 0;
      const endless = await test.browser().send(
        new Request("https://pigy.test/api/v1/media", {
          method: "POST",
          headers: { Authorization: `Bearer ${secret}` },
          body: new ReadableStream<Uint8Array>({
            pull(controller) {
              sent += 1024 * 1024;
              controller.enqueue(new Uint8Array(1024 * 1024));
            },
          }),
          duplex: "half",
        } as RequestInit),
      );
      expect(endless.status).toBe(413);
      expect(sent).toBeLessThan(maxImageBytes + 8 * 1024 * 1024);
      expect(await kept(workspace)).toEqual([]);
    });
  },
);

it("says what a sandbox can fetch when a post names an address of the internet", async () => {
  const { test, api } = await ready("sandbox");
  expect(
    await api.refused(
      "/posts",
      {
        method: "POST",
        json: {
          text: "x",
          saveToDraft: true,
          assets: [{ image: { url: "https://example.com/cat.png" } }],
        },
      },
      400,
    ),
  ).toMatchObject({
    field: "assets.0.image.url",
    message: expect.stringContaining(sandboxImage),
  });
  // The simulated world was asked, and the internet was not.
  expect(test.network.requests).toEqual([]);
});

/** Answers in place of the internet at `host`, and passes the rest on. */
const answerAt =
  (host: string, answer: (url: string, signal?: AbortSignal) => Response) =>
  (network: Fetch): Fetch =>
  async (input, init) => {
    const url = urlOf(input);
    if (new URL(url).host !== host) return network(input, init);
    test?.network.requests.push(`GET ${url}`);
    return answer(url, init?.signal ?? undefined);
  };

// For `answerAt`, which runs before `ready` has made the test.
let test: TestSetup | undefined;

/** A post that names the image at `url`, refused with its reason. */
async function refusedImage(api: ApiClient, url: string) {
  const refused = await api.refused(
    "/posts",
    {
      method: "POST",
      json: {
        text: "x",
        saveToDraft: true,
        assets: [{ image: { url } }],
      },
    },
    400,
  );
  expect(refused.field).toBe("assets.0.image.url");
  return refused.message.replace("assets.0.image.url: ", "");
}

describe("an address of a live workspace that leads to no image", () => {
  it("is not followed where it sends pigy on to a private address", async () => {
    const context = await ready("live", {
      interceptNetwork: answerAt(
        "images.example.com",
        () =>
          new Response(null, {
            status: 302,
            headers: { Location: "https://127.0.0.1/admin" },
          }),
      ),
    });
    test = context.test;
    expect(
      await refusedImage(context.api, "https://images.example.com/a.png"),
    ).toContain("does not follow");
    expect(
      context.test.network.requests.filter((request) =>
        request.includes("127.0.0.1"),
      ),
    ).toEqual([]);
  });

  it("is given up where its file never ends, at the bytes that an image may have", async () => {
    let sent = 0;
    let cancelled = false;
    const context = await ready("live", {
      interceptNetwork: answerAt(
        "images.example.com",
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              // A body without an end: it gives for as long as it is asked.
              pull(controller) {
                sent += 1024 * 1024;
                controller.enqueue(new Uint8Array(1024 * 1024));
              },
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { "Content-Type": "image/png" } },
          ),
      ),
    });
    expect(
      await refusedImage(context.api, "https://images.example.com/a.png"),
    ).toBe(`The file is larger than ${maxImageBytes / 1024 / 1024} MiB.`);
    expect(cancelled).toBe(true);
    expect(sent).toBeLessThan(maxImageBytes + 8 * 1024 * 1024);
    expect(await kept(context.workspace)).toEqual([]);
  });

  it("is given up where its file does not arrive in time", async () => {
    const context = await ready("live", {
      assetTimeoutMs: 200,
      interceptNetwork: answerAt(
        "images.example.com",
        (_url, signal) =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(10));
                // Nothing more comes. A real body is ended by the signal
                // of its request, as this one is.
                signal?.addEventListener("abort", () =>
                  controller.error(signal.reason),
                );
              },
            }),
          ),
      ),
    });
    expect(
      await refusedImage(context.api, "https://images.example.com/a.png"),
    ).toBe("The image did not arrive within 0.2 seconds.");
  });

  it("is refused where its answer says that its file is too large, before it is read", async () => {
    let pulled = 0;
    const context = await ready("live", {
      interceptNetwork: answerAt(
        "images.example.com",
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                pulled += 1;
                controller.enqueue(new Uint8Array(1024));
              },
            }),
            { headers: { "Content-Length": String(maxImageBytes + 1) } },
          ),
      ),
    });
    expect(
      await refusedImage(context.api, "https://images.example.com/a.png"),
    ).toContain("larger than");
    // A stream fills its buffer before anybody reads: that much is asked
    // of it, and nothing more.
    expect(pulled).toBeLessThanOrEqual(2);
  });

  it("is refused where it answers with an error, and takes what a file is from its bytes and not from its answer", async () => {
    const png = await pngFile(40, 30);
    const context = await ready("live", {
      interceptNetwork: answerAt("images.example.com", (url) =>
        url.endsWith("/gone.png")
          ? new Response("Not here", { status: 404 })
          : // A picture said to be a page.
            new Response(png as Uint8Array<ArrayBuffer>, {
              headers: { "Content-Type": "text/html" },
            }),
      ),
    });
    expect(
      await refusedImage(context.api, "https://images.example.com/gone.png"),
    ).toBe("The address answered with the status 404, and not with a file.");
    const post = await context.api.create({
      text: "x",
      saveToDraft: true,
      assets: [{ image: { url: "https://images.example.com/page.html" } }],
    });
    expect(post.assets).toMatchObject([{ image: { status: "ready" } }]);
    const { media } = await rowsOf(context.browser, context.workspace);
    expect(media).toMatchObject([{ type: "image/png", width: 40, height: 30 }]);
  });
});

it("names an image by its ID only in its own workspace, and refuses one that is not there", async () => {
  const { test, browser, workspaces, api } = await ready("live");
  const sandbox = apiClient(
    test,
    (await makeKey(browser, workspaces.sandbox)).secret,
  );
  const response = await upload(sandbox, await photo());
  const { id } = apiMediaSchema.parse(await response.json());
  for (const mediaId of [id, "01939c2e-0000-7000-8000-000000000000"]) {
    expect(
      await api.refused(
        "/posts",
        {
          method: "POST",
          json: {
            text: "x",
            saveToDraft: true,
            assets: [{ image: { mediaId } }],
          },
        },
        400,
      ),
    ).toMatchObject({ field: "assets.0.image.mediaId" });
  }
});

it("changes the images of a post as a part of a draft is changed, and keeps those that a change names again", async () => {
  const { browser, workspace, api } = await ready("live");
  const [first, second] = await Promise.all([photo(), photo(200, 300)]);
  const one = apiMediaSchema.parse(
    await (await upload(api, first as Uint8Array)).json(),
  );
  const two = apiMediaSchema.parse(
    await (await upload(api, second as Uint8Array)).json(),
  );
  const asset = (mediaId: string, altText = "") => ({
    image: { mediaId, metadata: { altText } },
  });
  const draft = await api.create({
    text: "Two images",
    saveToDraft: true,
    assets: [asset(one.id, "One")],
    metadata: { thread: [{ text: "Second", assets: [asset(two.id)] }] },
  });
  const patch = async (json: unknown): Promise<ApiPost> =>
    apiPostSchema.parse(
      await api.ok(`/posts/${draft.id}`, { method: "PATCH", json }),
    );
  const rowIds = async () =>
    (await rowsOf(browser, workspace)).partMedia.map(({ id }) => id).sort();
  const before = await rowIds();

  // The same image again, with another description: the row stays.
  expect(
    (await patch({ assets: [asset(one.id, "The first")] })).assets,
  ).toMatchObject([
    { image: { mediaId: one.id, metadata: { altText: "The first" } } },
  ]);
  expect(await rowIds()).toEqual(before);

  // A part of the thread that is named without images keeps its own.
  const kept = await patch({ metadata: { thread: [{ text: "Changed" }] } });
  expect(kept.metadata.thread).toMatchObject([
    { text: "Changed", assets: [{ image: { mediaId: two.id } }] },
  ]);

  // Other images take the place of those that the part had, and none
  // takes them all away. A new part has the images that it names.
  const swapped = await patch({
    assets: [asset(two.id), asset(one.id)],
    metadata: {
      thread: [
        { text: "Changed", assets: [] },
        { text: "Third", assets: [asset(one.id, "Again")] },
      ],
    },
  });
  expect(swapped.assets.map(({ image }) => image.mediaId)).toEqual([
    two.id,
    one.id,
  ]);
  expect(swapped.metadata.thread).toMatchObject([
    { text: "Changed", assets: [] },
    { text: "Third", assets: [{ image: { mediaId: one.id } }] },
  ]);
});

it("gives the channels of a service images of their own, or the post's where it names none", async () => {
  const { api, channel } = await ready("live");
  const image = apiMediaSchema.parse(
    await (await upload(api, await photo())).json(),
  );
  const asset = { image: { mediaId: image.id, metadata: { altText: "Own" } } };
  const post = await api.create({
    text: "Post",
    saveToDraft: true,
    channelIds: [channel],
    assets: [asset],
    metadata: { mastodon: { text: "For Mastodon" } },
  });
  // Customized, as the editor does it: with the images of the post.
  expect(post.targets).toMatchObject([
    {
      customized: true,
      text: "For Mastodon",
      assets: [{ image: { mediaId: image.id } }],
      thread: [],
    },
  ]);
  const own = apiPostSchema.parse(
    await api.ok(`/posts/${post.id}`, {
      method: "PATCH",
      json: {
        metadata: {
          mastodon: {
            text: "No image",
            assets: [],
            thread: [{ text: "One", assets: [asset] }],
          },
        },
      },
    }),
  );
  expect(own.assets).toMatchObject([{ image: { mediaId: image.id } }]);
  expect(own.targets).toMatchObject([
    {
      text: "No image",
      assets: [],
      thread: [{ text: "One", assets: [{ image: { mediaId: image.id } }] }],
    },
  ]);
});

it("does not send a post with an image to LinkedIn, which pigy publishes no images to yet", async () => {
  const { test, browser, workspaces, api } = await ready("sandbox");
  const { channel } = await connectLinkedInInSandbox(
    browser,
    workspaces.sandbox,
  );
  void test;
  expect(
    await api.refused(
      "/posts",
      {
        method: "POST",
        json: {
          text: "A picture",
          channelIds: [channel],
          mode: "shareNow",
          assets: [{ image: { url: sandboxImage } }],
        },
      },
      400,
    ),
  ).toMatchObject({
    field: "text",
    message: expect.stringContaining("LinkedIn"),
  });
});

it("needs the scope media:write to upload, which a key of the posts alone does not have", async () => {
  const { test, browser, workspace } = await ready("live");
  const posts = apiClient(
    test,
    (
      await makeKey(browser, workspace, {
        scopes: ["posts:read", "posts:write"],
      })
    ).secret,
  );
  const refused = await upload(posts, await photo());
  expect(refused.status).toBe(403);
  // A post can name an image by its address without it.
  expect(
    (
      await posts.create({
        text: "x",
        saveToDraft: true,
        assets: [{ image: { url: sandboxImage } }],
      })
    ).assets,
  ).toHaveLength(1);
});

it("counts what a person uploads with their keys and in the app together, and says when to come again", async () => {
  const { test, api } = await ready("live");
  const { id: owner } = (await api.ok("/account")) as { id: string };
  // Nearly all of the minute used up, as forty images of the app would.
  const minute = Math.floor(test.clock.time.getTime() / 60_000) * 60_000;
  await drizzle(env.DB)
    .insert(uploadUses)
    .values({
      userId: owner,
      windowStart: minute,
      count: uploadRequestsPerMinute - 2,
    });
  const file = await photo();
  // A file of one chunk counts as three requests of the app: the one
  // that begins an upload, its chunk, and the one that completes it.
  const refused = await upload(api, file);
  expect(refused.status).toBe(429);
  expect(refused.headers.get("Retry-After")).toBe("60");
  expect(await refused.json()).toMatchObject({ error: "LimitReachedError" });
  // And so is a post that names an image by its address.
  expect(
    (
      await api.call("/posts", {
        method: "POST",
        json: {
          text: "x",
          saveToDraft: true,
          assets: [{ image: { url: sandboxImage } }],
        },
      })
    ).status,
  ).toBe(429);
  test.advance(60_000);
  expect((await upload(api, file)).status).toBe(201);
});

it("makes one image of a file that is sent twice under one Idempotency-Key, and refuses another file under it", async () => {
  const { workspace, api } = await ready("live");
  const file = await photo();
  const first = await upload(api, file, { "Idempotency-Key": "photo-1" });
  expect(first.status).toBe(201);
  const made = apiMediaSchema.parse(await first.json());
  const again = await upload(api, file, { "Idempotency-Key": "photo-1" });
  expect(again.status).toBe(201);
  expect(again.headers.get("Idempotent-Replayed")).toBe("true");
  expect(apiMediaSchema.parse(await again.json())).toEqual(made);
  const other = await upload(api, await photo(100, 100), {
    "Idempotency-Key": "photo-1",
  });
  expect(other.status).toBe(422);
  // What the repeat and the refused request stored is gone again.
  await vi.waitFor(async () => {
    expect(await kept(workspace)).toEqual([
      `${made.id}/original`,
      `${made.id}/thumbnail`,
    ]);
  }, patience);
});

it("refuses an image that would take a workspace past the bytes of images that it holds", async () => {
  const { workspace, api } = await ready("live");
  // Rows that say that the workspace holds 2 GiB of images, without the
  // bytes: the count goes by the rows.
  await runInDurableObject(objectOf(workspace), (_, state) => {
    const size = 20 * 1024 * 1024;
    for (let index = 0; index * size < maxWorkspaceMediaBytes; index++) {
      state.storage.sql.exec(
        `insert into media (id, kind, status, name, type, size, width, height, animated, created_at)
         values (?, 'image', 'ready', '', 'image/png', ?, 1, 1, 0, 0)`,
        `01939c2e-0000-7000-8000-${String(index).padStart(12, "0")}`,
        size,
      );
    }
  });
  const response = await upload(api, await photo());
  expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({
    message: expect.stringContaining("holds as many images as it can"),
  });
  await vi.waitFor(async () => {
    expect(
      (await kept(workspace)).filter((key) => !key.startsWith("01939c2e")),
    ).toEqual([]);
  }, patience);
});
