import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  chunksOf,
  type ImageFacts,
  mediaFilePath,
  mediaUploadPath,
  type Row,
  scanImage,
  uploadChunkRange,
  uploadChunks,
  uploadStateSchema,
} from "@pigy/core";
import { joined, pngFile } from "@pigy/core/test-images";
import { expect, vi } from "vitest";
import type { Browser } from "./helpers.ts";
import { follow, patience, postOf } from "./publishing.ts";
import { newId, objectOf, type SyncClient } from "./sync-client.ts";

/**
 * What the tests of images share: the steps of a device that uploads a
 * file, and ways to look at what the bucket has.
 */

/** What reading `file` finds, as a device reads it before it uploads. */
export const factsOf = (file: Uint8Array): Promise<ImageFacts> =>
  scanImage(chunksOf(new Blob([file as Uint8Array<ArrayBuffer>]).stream()));

/**
 * A photo of this size, as a camera writes one: a JPEG that a decoder
 * draws, made of a PNG by the Images binding of the test, with an Exif
 * segment put behind its start that says where it was taken.
 */
export async function photo(width = 320, height = 240): Promise<Uint8Array> {
  const made = await env.IMAGES.input(
    new Blob([
      (await pngFile(width, height, {
        noise: true,
      })) as Uint8Array<ArrayBuffer>,
    ]).stream(),
  ).output({ format: "image/jpeg", quality: 80 });
  const jpeg = new Uint8Array(await made.response().arrayBuffer());
  const exif = new TextEncoder().encode(
    `Exif\0\0II*\0\x08\0\0\0\0\0${gpsText}`,
  );
  return joined(
    jpeg.subarray(0, 2),
    [0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 0xff],
    exif,
    jpeg.subarray(2),
  );
}

/** What the Exif of `photo` says, which pigy must not keep or publish. */
export const gpsText = "GPS 45.4642 N 9.1900 E";

/** Whether `bytes` have `text` in them anywhere. */
export const holds = (bytes: Uint8Array, text: string) =>
  new TextDecoder("latin1").decode(bytes).includes(text);

/**
 * Makes the row of an image as a device does, with what the device says
 * of the file: what it read in it, unless `says` says otherwise. Returns
 * the ID of the image.
 */
export async function createMedia(
  client: SyncClient,
  file: Uint8Array,
  says: Partial<Row<"media">> = {},
): Promise<string> {
  const id = newId();
  const facts = await factsOf(file).catch(() => ({
    type: "image/jpeg" as const,
    width: 10,
    height: 10,
    animated: false,
  }));
  client.mutate("media.create", {
    id,
    name: "image",
    type: facts.type,
    width: facts.width,
    height: facts.height,
    animated: facts.animated,
    size: file.length,
    ...says,
  });
  const { rejected } = await client.patch();
  expect(rejected).toEqual([]);
  return id;
}

/** Begins the upload of an image, or takes it up again. */
export async function beginUpload(
  browser: Browser,
  workspaceId: string,
  mediaId: string,
) {
  const response = await browser.fetch(mediaUploadPath(workspaceId, mediaId), {
    method: "POST",
  });
  expect(response.status).toBe(200);
  return uploadStateSchema.parse(await response.json());
}

/** Sends the chunk `number` of `file`, and returns the answer. */
export function sendChunk(
  browser: Browser,
  workspaceId: string,
  mediaId: string,
  file: Uint8Array,
  number: number,
): Promise<Response> {
  const { start, end } = uploadChunkRange(file.length, number);
  return browser.fetch(`${mediaUploadPath(workspaceId, mediaId)}/${number}`, {
    method: "PUT",
    body: file.subarray(start, end),
  });
}

/** Says that every chunk is there, and returns the answer. */
export const completeUpload = (
  browser: Browser,
  workspaceId: string,
  mediaId: string,
) =>
  browser.fetch(`${mediaUploadPath(workspaceId, mediaId)}/complete`, {
    method: "POST",
  });

/** The row of the image as `client` has it. */
export function mediaOf(client: SyncClient, mediaId: string): Row<"media"> {
  const media = client.table("media").find(({ id }) => id === mediaId);
  if (!media) throw new Error(`The client has no image ${mediaId}`);
  return media;
}

/**
 * Uploads `file` as a device does, from the row to the last chunk, and
 * follows `client` until the row says how it ended. Returns the row.
 */
export async function upload(
  browser: Browser,
  client: SyncClient,
  workspaceId: string,
  file: Uint8Array,
  says: Partial<Row<"media">> = {},
): Promise<Row<"media">> {
  const mediaId = await createMedia(client, file, says);
  await beginUpload(browser, workspaceId, mediaId);
  for (let number = 1; number <= uploadChunks(file.length); number++) {
    const sent = await sendChunk(browser, workspaceId, mediaId, file, number);
    expect(sent.status).toBe(200);
  }
  const completed = await completeUpload(browser, workspaceId, mediaId);
  expect(completed.status).toBe(200);
  await follow(client, () => mediaOf(client, mediaId).status !== "uploading");
  return mediaOf(client, mediaId);
}

/** Puts an image into a part, as the editor does. Returns the ID of the row. */
export async function attach(
  client: SyncClient,
  partId: string,
  mediaId: string,
  alt = "",
): Promise<string> {
  const id = newId();
  client.mutate("media.attach", { id, partId, mediaId, alt });
  const { rejected } = await client.patch();
  expect(rejected).toEqual([]);
  return id;
}

/** The bytes that the app serves of an image to `browser`. */
export async function served(
  browser: Browser,
  workspaceId: string,
  mediaId: string,
  which: "original" | "thumbnail" = "original",
): Promise<Uint8Array> {
  const response = await browser.fetch(
    mediaFilePath(workspaceId, mediaId, which),
  );
  expect(response.status).toBe(200);
  return new Uint8Array(await response.arrayBuffer());
}

/** What the bucket has of `workspaceId`, as the names of its files. */
export async function kept(workspaceId: string): Promise<string[]> {
  const { objects } = await env.MEDIA.list({ prefix: `${workspaceId}/` });
  return objects.map(({ key }) => key.slice(workspaceId.length + 1)).sort();
}

/** Runs the alarm of a workspace now. */
export async function look(workspaceId: string): Promise<void> {
  await runDurableObjectAlarm(objectOf(workspaceId));
}

/**
 * Follows `client` until the post has left `sending`, and returns it,
 * like `ended` of publishing.ts, for a delivery that makes a smaller
 * image on its way: that takes seconds on a machine under load, in which
 * the server has nothing to say, and a client gives a message two.
 */
export async function endedWithImages(
  client: SyncClient,
  postId: string,
): Promise<Row<"post">> {
  while (postOf(client, postId).status === "sending") {
    await vi.waitFor(() => expect(client.unread).toBeGreaterThan(0), patience);
    await client.patch();
  }
  return postOf(client, postId);
}
