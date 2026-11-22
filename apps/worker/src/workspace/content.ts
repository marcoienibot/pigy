import {
  type ContentImage,
  inReadingOrder,
  type PostContent,
  partsFor,
} from "@pigy/core";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { contentImageId } from "../media/keys.ts";
import { findRows, readRow } from "./synced.ts";

/**
 * What the account of the target `targetId` gets of the post `postId`:
 * the text that was written for it, or the post's own, part by part, each
 * with its images. A delivery publishes it, and the public API checks it
 * with `validateContent` before a post goes out, as the editor checks
 * what it shows: one content, so that the two cannot judge different
 * things.
 */
export function contentFor(
  db: DrizzleSqliteDODatabase,
  postId: string,
  targetId: string,
): PostContent {
  return {
    parts: partsFor(findRows(db, "post_part", "postId", postId), targetId).map(
      ({ id, text }) => {
        const images = imagesOf(db, id);
        // Left out for a part without any, so that a post without images
        // is what it was before pigy had them.
        return images.length > 0 ? { text, media: images } : { text };
      },
    ),
  };
}

/**
 * The images of the part `partId` as a delivery publishes them, in the
 * order they are shown in: each as the workspace keeps it, with what says
 * so if it cannot be published as things are. `validateContent` goes by
 * that, and a delivery makes a smaller image where its network needs one.
 */
function imagesOf(db: DrizzleSqliteDODatabase, partId: string): ContentImage[] {
  return inReadingOrder(findRows(db, "part_media", "partId", partId)).map(
    ({ mediaId, alt }) => {
      const image = readRow(db, "media", mediaId);
      const missing =
        !image || image.originalGoneAt !== null
          ? "gone"
          : image.status === "ready"
            ? undefined
            : image.status;
      return {
        id: contentImageId(mediaId, "original"),
        // Of a row that is gone nothing is known: it is never published,
        // and these only have to be an image's.
        type: image?.type ?? "image/jpeg",
        size: image?.size ?? 1,
        width: image?.width ?? 1,
        height: image?.height ?? 1,
        ...(image?.animated && { animated: true }),
        alt,
        ...(missing && { missing }),
      };
    },
  );
}
