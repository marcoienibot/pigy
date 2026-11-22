import {
  chunksOf,
  cleanImage,
  type ImageFacts,
  ImageRefused,
  scanImage,
} from "@pigy/core";
import type { MediaUpload, UploadOutcome } from "../workspace/store.ts";
import { deleteUnder, mediaKeys } from "./keys.ts";
import { type ImageTransformer, makeThumbnail } from "./transform.ts";

/**
 * Takes in an image whose parts the bucket has: puts them together, reads
 * the file, and keeps what pigy keeps of an image. Returns what it found
 * in the bytes, or why the file is not taken.
 *
 * What a device said of the file counts for nothing here. The type and
 * the dimensions are read from the bytes, `scanImage` of @pigy/core, and
 * a file that is not laid out as one of the four types is refused. Then
 * the copy is made that pigy keeps and publishes, without what a camera
 * wrote next to the picture: `cleanImage`. And a small picture is made of
 * that copy, which is the one place where the file is decoded: one that
 * says it is an image and cannot be drawn is refused there.
 *
 * The file is read from the bucket as a stream, twice, and written back as
 * one. It is never in memory as a whole: only the small picture is.
 *
 * It fails, for the caller to try again, when the bucket fails. A second
 * try finds the parts put together already and goes on from there.
 */
export async function takeIn(
  bucket: R2Bucket,
  transformer: ImageTransformer,
  workspaceId: string,
  mediaId: string,
  upload: MediaUpload & { uploadId: string },
): Promise<UploadOutcome> {
  const keys = mediaKeys(workspaceId, mediaId);
  // Put together already, by a try before this one that did not get to
  // say so: finishing an upload a second time fails.
  if (!(await bucket.head(keys.upload))) {
    await bucket
      .resumeMultipartUpload(keys.upload, upload.uploadId)
      .complete(upload.parts);
  }
  const refused = async (error: string): Promise<UploadOutcome> => {
    await deleteUnder(bucket, keys.prefix);
    return { error };
  };
  const whole = async () => {
    const file = await bucket.get(keys.upload);
    if (!file) throw new Error("The upload is not in the bucket");
    return file;
  };

  let facts: ImageFacts;
  try {
    const file = await whole();
    if (file.size !== upload.size) {
      return refused("The file is not as long as the device said.");
    }
    facts = await scanImage(chunksOf(file.body));
  } catch (error) {
    if (error instanceof ImageRefused) return refused(error.message);
    throw error;
  }

  // The copy, written as it is read. Its length is known from the first
  // reading, which the bucket asks for of a stream.
  const { readable, writable } = new FixedLengthStream(facts.size);
  const stored = bucket.put(keys.original, readable, {
    httpMetadata: { contentType: facts.type },
  });
  const writer = writable.getWriter();
  try {
    await cleanImage(chunksOf((await whole()).body), facts, async (piece) => {
      await writer.write(piece);
    });
    await writer.close();
    await stored;
  } catch (error) {
    await writer.abort(error).catch(() => {});
    await stored.catch(() => {});
    throw error;
  }

  let thumbnail: Awaited<ReturnType<typeof makeThumbnail>> | undefined;
  // Twice: what draws pictures does not say whether it failed for the
  // file or for a reason of its own, and a file is not refused for one
  // request that went wrong.
  for (let tries = 0; tries < 2 && !thumbnail; tries++) {
    const copy = await bucket.get(keys.original);
    if (!copy) throw new Error("The image is not in the bucket");
    try {
      thumbnail = await makeThumbnail(transformer, copy.body);
    } catch (error) {
      console.warn(
        "No small picture could be made of an image",
        error instanceof Error ? error.message : error,
      );
    }
  }
  if (!thumbnail) {
    // That it is laid out as an image was all that was known of it until
    // here.
    return refused(
      "The file is laid out as an image, and pigy could make no picture of it: it is damaged. If it opens elsewhere, attach it again.",
    );
  }
  await bucket.put(keys.thumbnail, thumbnail.bytes, {
    httpMetadata: { contentType: thumbnail.facts.type },
  });
  await bucket.delete(keys.upload);
  return { facts };
}
