import { env } from "cloudflare:workers";
import {
  mediaFilePath,
  mediaUploadPath,
  unattachedMs,
  uploadChunkBytes,
  uploadLifetimeMs,
  uploadRequestsPerMinute,
} from "@pigy/core";
import {
  joined,
  pngChunk,
  pngFile,
  pngHeader,
  pngSignature,
} from "@pigy/core/test-images";
import { expect, onTestFinished, test, vi } from "vitest";
import { imagePolicy } from "../src/security-headers.ts";
import { dropUploadForMs, WorkspaceStore } from "../src/workspace/store.ts";
import {
  adminEmail,
  entriesOf,
  expectErrors,
  expectWarnings,
  invite,
  setup,
  signedIn,
} from "./helpers.ts";
import {
  attach,
  beginUpload,
  completeUpload,
  createMedia,
  factsOf,
  gpsText,
  holds,
  kept,
  look,
  mediaOf,
  photo,
  sendChunk,
  served,
  upload,
} from "./media.ts";
import { follow, patience, writeDraft } from "./publishing.ts";
import { newId, SyncClient, workspaceIds } from "./sync-client.ts";

/** A signed-in admin with a client of their live workspace. */
async function ready() {
  const test = setup();
  const browser = await signedIn(test, { email: adminEmail });
  const workspaces = await workspaceIds(browser);
  const client = new SyncClient();
  await client.connect(browser, workspaces.live);
  return { test, browser, client, workspaceId: workspaces.live };
}

test("an image is uploaded, read by the server, kept without what the camera wrote, and served to its owner", async () => {
  const { browser, client, workspaceId } = await ready();
  const file = await photo(320, 240);
  expect(holds(file, gpsText)).toBe(true);

  // The device says something else of the file than is true.
  const media = await upload(browser, client, workspaceId, file, {
    type: "image/png",
    width: 9999,
    height: 1,
  });

  // The row has what the server read in the bytes.
  expect(media).toMatchObject({
    status: "ready",
    type: "image/jpeg",
    width: 320,
    height: 240,
    animated: false,
    error: null,
  });
  // The copy is smaller by what was left out, and the row says its size.
  expect(media.size).toBeLessThan(file.length);
  expect(await kept(workspaceId)).toEqual([
    `${media.id}/original`,
    `${media.id}/thumbnail`,
  ]);

  const response = await browser.fetch(
    mediaFilePath(workspaceId, media.id, "original"),
  );
  expect(response.status).toBe(200);
  expect(Object.fromEntries(response.headers)).toMatchObject({
    "content-type": "image/jpeg",
    "x-content-type-options": "nosniff",
    "content-disposition": 'attachment; filename="image.jpeg"',
    "cache-control": "no-store",
    // The route's own policy, which the middleware that gives every
    // answer one leaves as it is: nothing of a page, and a sandbox.
    "content-security-policy": imagePolicy,
  });
  const original = new Uint8Array(await response.arrayBuffer());
  expect(original.length).toBe(media.size);
  expect(holds(original, gpsText)).toBe(false);
  // Still the picture: a decoder reads it as what it was.
  expect(await factsOf(original)).toMatchObject({ width: 320, height: 240 });

  const thumbnail = await served(browser, workspaceId, media.id, "thumbnail");
  expect(await factsOf(thumbnail)).toMatchObject({ type: "image/webp" });
});

test("nobody but the owner of the workspace is served an image", async () => {
  const { test: app, browser, client, workspaceId } = await ready();
  const media = await upload(browser, client, workspaceId, await pngFile(8, 8));
  const path = mediaFilePath(workspaceId, media.id, "original");

  const stranger = app.browser();
  expect((await stranger.fetch(path)).status).toBe(401);

  // Somebody else who is signed in, and asks for the image by its
  // address: the workspace is not theirs, so it is not there for them.
  await invite(app, "friend@example.com");
  const friend = await signedIn(app, { email: "friend@example.com" });
  expect((await friend.fetch(path)).status).toBe(404);
  // Nor in a workspace of their own, under the ID of the image.
  const theirs = await workspaceIds(friend);
  expect(
    (await friend.fetch(mediaFilePath(theirs.live, media.id, "original")))
      .status,
  ).toBe(404);
  expect(
    (
      await friend.fetch(mediaUploadPath(workspaceId, media.id), {
        method: "POST",
      })
    ).status,
  ).toBe(404);
});

test("an upload that was cut off goes on from the chunks that arrived", async () => {
  const { browser, client, workspaceId } = await ready();
  // Noise does not compress: a file of two chunks.
  const file = await pngFile(1400, 1300, { noise: true });
  expect(file.length).toBeGreaterThan(uploadChunkBytes);
  const mediaId = await createMedia(client, file);

  expect(await beginUpload(browser, workspaceId, mediaId)).toEqual({
    chunkBytes: uploadChunkBytes,
    received: [],
  });
  expect((await sendChunk(browser, workspaceId, mediaId, file, 1)).status).toBe(
    200,
  );
  // Not complete: the server says so, and the image stays on its way.
  expect((await completeUpload(browser, workspaceId, mediaId)).status).toBe(
    409,
  );

  // The device comes back, as after a reload: it asks what arrived.
  expect(await beginUpload(browser, workspaceId, mediaId)).toMatchObject({
    received: [1],
  });
  const second = await sendChunk(browser, workspaceId, mediaId, file, 2);
  expect(await second.json()).toMatchObject({ received: [1, 2] });
  expect((await completeUpload(browser, workspaceId, mediaId)).status).toBe(
    200,
  );
  await follow(client, () => mediaOf(client, mediaId).status === "ready");
  // Byte for byte what was sent: this PNG has nothing to leave out.
  expect(await served(browser, workspaceId, mediaId)).toEqual(file);

  // A completion that is repeated, because its answer was lost, is
  // answered as the first was and takes nothing in again.
  const again = await completeUpload(browser, workspaceId, mediaId);
  expect(await again.json()).toEqual({ status: "ready" });
});

test.each([
  ["an image", async () => pngFile(8, 8), "ready", ["original", "thumbnail"]],
  [
    "a file that is refused",
    async () => new TextEncoder().encode("<script>alert(1)</script>"),
    "failed",
    [],
  ],
] as const)(
  "a completion of %s whose workspace could not be told is completed by the next one",
  async (_, make, status, files) => {
    const { browser, client, workspaceId } = await ready();
    const file = await make();
    const mediaId = await createMedia(client, file);
    await beginUpload(browser, workspaceId, mediaId);
    await sendChunk(browser, workspaceId, mediaId, file, 1);
    // The bytes are taken in, and the call that says so to the
    // workspace fails, as when a deploy takes the object away under it.
    const finish = vi
      .spyOn(WorkspaceStore.prototype, "finishUpload")
      .mockImplementationOnce(() => {
        throw new Error("The object went away");
      });
    try {
      expect((await completeUpload(browser, workspaceId, mediaId)).status).toBe(
        500,
      );
    } finally {
      finish.mockRestore();
    }
    // The device asks again. Before, the first completion had deleted the
    // file that the parts made, and the second completed the parts once
    // more, which the bucket refuses: every try failed for a week.
    const again = await completeUpload(browser, workspaceId, mediaId);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status });
    await follow(client, () => mediaOf(client, mediaId).status === status);
    expect(await kept(workspaceId)).toEqual(
      files.map((name) => `${mediaId}/${name}`),
    );
  },
);

test("two completions at once both say how the upload ended, and the file is taken in once", async () => {
  const { browser, client, workspaceId } = await ready();
  const file = await pngFile(8, 8);
  const mediaId = await createMedia(client, file);
  await beginUpload(browser, workspaceId, mediaId);
  await sendChunk(browser, workspaceId, mediaId, file, 1);
  // Two tabs, or a device that asked again before its first answer came.
  const answers = await Promise.all([
    completeUpload(browser, workspaceId, mediaId),
    completeUpload(browser, workspaceId, mediaId),
  ]);
  expect(answers.map(({ status }) => status)).toEqual([200, 200]);
  expect(await Promise.all(answers.map((answer) => answer.json()))).toEqual([
    { status: "ready" },
    { status: "ready" },
  ]);
  await follow(client, () => mediaOf(client, mediaId).status === "ready");
  expect(await kept(workspaceId)).toEqual([
    `${mediaId}/original`,
    `${mediaId}/thumbnail`,
  ]);
  expect(await served(browser, workspaceId, mediaId)).toEqual(file);
});

test.each([
  [
    "the one that ends first takes the image in, and the other makes no small picture of it",
    "ready",
    ["original", "thumbnail"],
  ],
  [
    "the one that ends first makes no small picture of the image, and the other takes it in",
    "failed",
    [],
  ],
] as const)(
  "two completions at once that end differently both say what the workspace has, and the bucket keeps what that needs: %s",
  async (_, status, files) => {
    const { browser, client, workspaceId } = await ready();
    const file = await pngFile(8, 8);
    const mediaId = await createMedia(client, file);
    await beginUpload(browser, workspaceId, mediaId);
    await sendChunk(browser, workspaceId, mediaId, file, 1);
    expectWarnings();

    // The completion that is sent first waits, at a moment of the test's
    // choosing, until the other has ended: a value that both look at on a
    // timer, as `gate` of publishing.ts.
    const held = { reached: false, open: false };
    const hold = async () => {
      held.reached = true;
      while (!held.open) await new Promise((done) => setTimeout(done, 5));
    };
    // What draws pictures fails for the calls that `fails` names, by
    // their order, and for the one that waits, after its wait.
    const fails = status === "ready" ? [1, 3] : [2, 3];
    const images = Object.getPrototypeOf(env.IMAGES) as ImagesBinding;
    const input = images.input;
    let calls = 0;
    const drawing = vi.spyOn(images, "input").mockImplementation(function (
      this: ImagesBinding,
      stream,
      options,
    ) {
      calls += 1;
      const call = calls;
      if (!fails.includes(call)) return input.call(this, stream, options);
      const failing = {
        transform: () => failing,
        output: async () => {
          if (status === "ready" && call === 1) await hold();
          throw new Error(
            "IMAGES_TRANSFORM_ERROR 9412: the image could not be drawn",
          );
        },
      };
      return failing as unknown as ImageTransformer;
    });
    onTestFinished(() => drawing.mockRestore());
    // Where it is the other way round, the completion that is sent first
    // makes its small picture and waits before it keeps it.
    const bucket = Object.getPrototypeOf(env.MEDIA) as R2Bucket;
    const put = bucket.put;
    let thumbnails = 0;
    const keeping = vi.spyOn(bucket, "put").mockImplementation(async function (
      this: R2Bucket,
      key,
      ...rest
    ) {
      if (status === "failed" && key.endsWith("/thumbnail")) {
        thumbnails += 1;
        if (thumbnails === 1) await hold();
      }
      return put.call(this, key, ...rest);
    });
    onTestFinished(() => keeping.mockRestore());

    const late = completeUpload(browser, workspaceId, mediaId);
    await vi.waitFor(() => expect(held.reached).toBe(true), patience);
    const early = await completeUpload(browser, workspaceId, mediaId);
    expect(early.status).toBe(200);
    expect(await early.json()).toEqual({ status });
    held.open = true;
    // Before, the later one went by what it found itself, which the
    // workspace had not taken: it said the other thing, and deleted the
    // image that the workspace has as ready, or left behind the small
    // picture of one that failed.
    const answer = await late;
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ status });
    await follow(client, () => mediaOf(client, mediaId).status === status);
    expect(await kept(workspaceId)).toEqual(
      files.map((name) => `${mediaId}/${name}`),
    );
    if (status === "ready") {
      expect(await served(browser, workspaceId, mediaId)).toEqual(file);
    }
  },
);

test("a chunk is taken only as the bytes of its place in the file", async () => {
  const { browser, client, workspaceId } = await ready();
  const file = await pngFile(8, 8);
  const mediaId = await createMedia(client, file);
  await beginUpload(browser, workspaceId, mediaId);
  const put = (number: number, body: Uint8Array) =>
    browser.fetch(`${mediaUploadPath(workspaceId, mediaId)}/${number}`, {
      method: "PUT",
      body,
    });
  // Longer than the row says the file is, shorter, and a chunk that a
  // file of this length does not have.
  expect((await put(1, joined(file, [0]))).status).toBe(400);
  expect((await put(1, file.subarray(1))).status).toBe(400);
  expect((await put(2, file)).status).toBe(400);
  expect((await put(0, file)).status).toBe(400);
  expect((await put(1, file)).status).toBe(200);
});

test("a row that the server does not have yet is no upload, and the device asks again", async () => {
  const { browser, workspaceId } = await ready();
  // The mutation that makes the row is still in the outbox of the device.
  const response = await browser.fetch(mediaUploadPath(workspaceId, newId()), {
    method: "POST",
  });
  expect(response.status).toBe(404);
});

test.each([
  [
    "a script with the name of an image",
    async () => new TextEncoder().encode("<script>alert(1)</script>"),
    "not an image",
  ],
  [
    "a file whose header claims far more pixels than pigy takes",
    async () =>
      joined(
        pngSignature,
        pngHeader(60_000, 60_000),
        pngChunk("IDAT", [0x78, 0x9c, 0x03, 0, 0, 0, 0, 1]),
        pngChunk("IEND", []),
      ),
    "million pixels",
  ],
  [
    "a PNG whose header says another size than its data has",
    async () => {
      // The data of 3 by 2 pixels under a header of 40 by 30, with a
      // checksum that is right: laid out as a PNG, and no picture.
      const real = await pngFile(3, 2);
      return joined(pngSignature, pngHeader(40, 30), real.subarray(8 + 25));
    },
    "damaged",
  ],
] as const)(
  "%s is refused, and nothing of it is kept",
  async (_, make, why) => {
    const { browser, client, workspaceId } = await ready();
    const media = await upload(browser, client, workspaceId, await make());
    expect(media.status).toBe("failed");
    expect(media.error).toContain(why);
    expect(await kept(workspaceId)).toEqual([]);
    expect(
      (await browser.fetch(mediaFilePath(workspaceId, media.id, "original")))
        .status,
    ).toBe(404);
  },
);

test("of a file that is an image with a script behind it, the image is kept", async () => {
  const { browser, client, workspaceId } = await ready();
  const script = "<script>alert(document.cookie)</script>";
  const file = await pngFile(8, 8, {
    after: new Uint8Array(new TextEncoder().encode(script)),
  });
  const media = await upload(browser, client, workspaceId, file);
  expect(media.status).toBe("ready");
  const original = await served(browser, workspaceId, media.id);
  expect(holds(original, script)).toBe(false);
  expect(original).toEqual(await pngFile(8, 8));
});

test("an upload that is not finished within a week is given up", async () => {
  const { test: app, browser, client, workspaceId } = await ready();
  const file = await pngFile(1400, 1300, { noise: true });
  const mediaId = await createMedia(client, file);
  const { postId: _, partIds } = await writeDraft(client, workspaceId, "Hello");
  await attach(client, partIds[0] ?? "", mediaId);
  await beginUpload(browser, workspaceId, mediaId);
  await sendChunk(browser, workspaceId, mediaId, file, 1);

  // A day before the week is over, the upload can still be finished.
  app.advance(uploadLifetimeMs - 24 * 60 * 60 * 1000);
  await look(workspaceId);
  const later = new SyncClient();
  await later.connect(browser, workspaceId);
  expect(mediaOf(later, mediaId).status).toBe("uploading");

  app.advance(24 * 60 * 60 * 1000);
  await look(workspaceId);
  const after = new SyncClient();
  await after.connect(browser, workspaceId);
  expect(mediaOf(after, mediaId)).toMatchObject({
    status: "failed",
    error: "The upload was not finished within a week. Attach the image again.",
  });
  // The chunk that arrived is not kept, and no more is taken.
  expect((await sendChunk(browser, workspaceId, mediaId, file, 2)).status).toBe(
    409,
  );
  expect(await kept(workspaceId)).toEqual([]);
});

test("an image that is in no part is deleted after a day, and one that is in a part stays", async () => {
  const { test: app, browser, client, workspaceId } = await ready();
  const { partIds } = await writeDraft(client, workspaceId, "Hello");
  const stays = await upload(browser, client, workspaceId, await pngFile(8, 8));
  const goes = await upload(browser, client, workspaceId, await pngFile(9, 9));
  const never = await upload(browser, client, workspaceId, await pngFile(7, 7));
  await attach(client, partIds[0] ?? "", stays.id);
  const attached = await attach(client, partIds[0] ?? "", goes.id);

  // Taken out of the draft half a day in: its day begins then.
  app.advance(unattachedMs / 2);
  const second = new SyncClient();
  await second.connect(browser, workspaceId);
  second.mutate("media.detach", { id: attached });
  await second.patch();

  app.advance(unattachedMs / 2 + 1000);
  await look(workspaceId);
  const third = new SyncClient();
  await third.connect(browser, workspaceId);
  // The one that was never in a part is a day old. The one that was
  // taken out has half its day left, for an Undo.
  expect(
    third
      .table("media")
      .map(({ id }) => id)
      .sort(),
  ).toEqual([stays.id, goes.id].sort());
  expect(await kept(workspaceId)).not.toContain(`${never.id}/original`);

  app.advance(unattachedMs / 2);
  await look(workspaceId);
  const fourth = new SyncClient();
  await fourth.connect(browser, workspaceId);
  expect(fourth.table("media").map(({ id }) => id)).toEqual([stays.id]);
  expect(await kept(workspaceId)).toEqual([
    `${stays.id}/original`,
    `${stays.id}/thumbnail`,
  ]);
});

test.each([
  ["that is not finished within a week", uploadLifetimeMs, true],
  ["of an image that is in no part for a day", unattachedMs, false],
] as const)(
  "the parts of an upload %s are dropped by the bucket, also when it fails to the first time",
  async (_, after, inPart) => {
    const { test: app, browser, client, workspaceId } = await ready();
    const file = await pngFile(1400, 1300, { noise: true });
    const mediaId = await createMedia(client, file);
    if (inPart) {
      const { partIds } = await writeDraft(client, workspaceId, "Hello");
      await attach(client, partIds[0] ?? "", mediaId);
    }
    await beginUpload(browser, workspaceId, mediaId);
    await sendChunk(browser, workspaceId, mediaId, file, 1);

    // The bucket fails the first time that it is told to drop the parts,
    // for a reason of its own.
    const bucket = Object.getPrototypeOf(env.MEDIA) as R2Bucket;
    const resume = bucket.resumeMultipartUpload;
    let failures = 1;
    const uploads: R2MultipartUpload[] = [];
    const spy = vi
      .spyOn(bucket, "resumeMultipartUpload")
      .mockImplementation(function (this: R2Bucket, key, uploadId) {
        const upload = resume.call(this, key, uploadId);
        uploads.push(upload);
        return {
          key: upload.key,
          uploadId: upload.uploadId,
          uploadPart: (...args) => upload.uploadPart(...args),
          complete: (...args) => upload.complete(...args),
          abort: async () => {
            if (failures-- > 0) {
              throw new Error(
                "abortMultipartUpload: We encountered an internal error. Please try again. (10001)",
              );
            }
            await upload.abort();
          },
        };
      });
    /** Whether the bucket still has the upload, and bills its parts. */
    const billed = async () => {
      const upload = uploads[0];
      if (!upload) throw new Error("The upload was never dropped");
      try {
        await resume
          .call(env.MEDIA, upload.key, upload.uploadId)
          .uploadPart(3, new Uint8Array(8));
        return true;
      } catch (error) {
        expect(String(error)).toContain("(10024)");
        return false;
      }
    };
    const errors = expectErrors();
    try {
      app.advance(after + 1000);
      await look(workspaceId);
      // The log names the image by its ID, for whoever runs pigy.
      expect(entriesOf(errors)).toContainEqual(
        expect.objectContaining({
          kind: "media",
          message:
            "The upload of an image was not dropped, and is asked for again in an hour",
          workspaceId,
          mediaId,
        }),
      );
      // Given up: no chunk is taken any more. And the bucket still has the
      // parts, which pigy keeps track of.
      expect(
        (await sendChunk(browser, workspaceId, mediaId, file, 2)).status,
      ).toBe(409);
      expect(await billed()).toBe(true);
      const meanwhile = new SyncClient();
      await meanwhile.connect(browser, workspaceId);
      // The row stays until the bucket has dropped the parts.
      expect(mediaOf(meanwhile, mediaId).status).toBe("failed");

      // The bucket is asked again an hour later.
      app.advance(60 * 60 * 1000);
      await look(workspaceId);
      expect(await billed()).toBe(false);
      const after_ = new SyncClient();
      await after_.connect(browser, workspaceId);
      expect(after_.table("media").map(({ id }) => id)).toEqual(
        inPart ? [mediaId] : [],
      );
    } finally {
      spy.mockRestore();
    }
  },
);

test("an upload whose parts the bucket never drops is let go of eight days after it was given up, and the log says so once", async () => {
  const { test: app, browser, client, workspaceId } = await ready();
  const file = await pngFile(1400, 1300, { noise: true });
  const mediaId = await createMedia(client, file);
  await beginUpload(browser, workspaceId, mediaId);
  await sendChunk(browser, workspaceId, mediaId, file, 1);

  // The bucket fails every time that it is told to drop the parts, and
  // not with the code that pigy takes for an upload that is gone: a
  // bucket that says so in another way than pigy guessed.
  const bucket = Object.getPrototypeOf(env.MEDIA) as R2Bucket;
  const resume = bucket.resumeMultipartUpload;
  let asked = 0;
  const spy = vi
    .spyOn(bucket, "resumeMultipartUpload")
    .mockImplementation(function (this: R2Bucket, key, uploadId) {
      const upload = resume.call(this, key, uploadId);
      return {
        key: upload.key,
        uploadId: upload.uploadId,
        uploadPart: (...args) => upload.uploadPart(...args),
        complete: (...args) => upload.complete(...args),
        abort: async () => {
          asked += 1;
          throw new Error(
            "abortMultipartUpload: We encountered an internal error. Please try again. (10001)",
          );
        },
      };
    });
  onTestFinished(() => spy.mockRestore());
  const errors = expectErrors();
  const said = () =>
    entriesOf(errors)
      .filter((entry) => entry.mediaId === mediaId)
      .map(({ message }) => message);
  const again =
    "The upload of an image was not dropped, and is asked for again in an hour";
  const hour = 60 * 60 * 1000;

  // Given up, and in no part: the bucket is asked to drop the parts, and
  // asked again an hour later, and until the eight days are nearly over.
  app.advance(uploadLifetimeMs + 1000);
  await look(workspaceId);
  app.advance(hour);
  await look(workspaceId);
  app.advance(dropUploadForMs - 2 * hour);
  await look(workspaceId);
  expect(asked).toBe(3);
  expect(said()).toEqual([again, again, again]);

  // Once they are over, it is asked a last time, and the row lets go of
  // the upload: an image in no part is deleted then. Before, the bucket
  // was asked every hour for ever, with a line in the log each time, and
  // the row stayed.
  app.advance(hour + 1000);
  await look(workspaceId);
  expect(asked).toBe(4);
  expect(said()).toEqual([
    again,
    again,
    again,
    "The upload of an image was not dropped in eight days, and is not asked for again: the parts stay unless a lifecycle rule of the bucket drops them",
  ]);
  const later = new SyncClient();
  await later.connect(browser, workspaceId);
  expect(later.table("media")).toEqual([]);
  app.advance(hour);
  await look(workspaceId);
  expect(asked).toBe(4);
  expect(said()).toHaveLength(4);
});

test("a person makes only so many requests of an upload in a minute", async () => {
  const { test: app, browser, workspaceId } = await ready();
  const begin = () =>
    browser.fetch(mediaUploadPath(workspaceId, newId()), { method: "POST" });
  for (let request = 0; request < uploadRequestsPerMinute; request++) {
    expect((await begin()).status).toBe(404);
  }
  expect((await begin()).status).toBe(429);
  // The next minute begins anew.
  app.advance(60_000);
  expect((await begin()).status).toBe(404);
});

test("the bucket is asked for nothing under a name that a request makes up", async () => {
  const { browser, workspaceId } = await ready();
  await env.MEDIA.put(`${workspaceId}/secret`, "not an image");
  for (const path of [
    `/api/workspaces/${workspaceId}/media/../secret`,
    `/api/workspaces/${workspaceId}/media/secret/original`,
    `/api/workspaces/${workspaceId}/media/${newId()}/upload`,
    `/api/workspaces/${workspaceId}/media/${newId()}/variants`,
  ]) {
    expect((await browser.fetch(path)).status).toBe(404);
  }
});
