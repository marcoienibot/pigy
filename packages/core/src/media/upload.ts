import { z } from "zod";
import { maxImageBytes } from "./image.ts";

/**
 * How a client hands the bytes of an image to the server, over HTTP, for a
 * row of `media` that it has made with the mutator `media.create` and that
 * the server has by then. SYNC.md, "Images", has the row.
 *
 * The file goes in chunks, each a request of its own, so that a
 * connection that is lost costs one chunk and not the file:
 *
 * 1. `POST <upload>` begins the upload, or takes it up again. The answer
 *    says how large a chunk is and which chunks the server has.
 * 2. `PUT <upload>/<number>` hands over one chunk, numbered from 1, as the
 *    body of the request: bytes `(number - 1) * chunkBytes` up to the next
 *    chunk or the end of the file, exactly. The answer says which chunks
 *    the server has now. A chunk can be sent again.
 * 3. `POST <upload>/complete` says that all chunks are there. The server
 *    puts them together and reads the image. What it found is not in the
 *    answer but in the row: `ready`, or `failed` with the reason.
 *
 * `<upload>` is `mediaUploadPath`. The size of the file is the `size` of
 * the row, which the client said when it made it, and the server takes no
 * byte more.
 *
 * A request for a row that the server does not have is answered with a
 * 404: the mutation that makes the row may still be on its way, and the
 * client asks again when it has been confirmed.
 */

/**
 * The size of a chunk, in bytes: 5 MiB, the smallest that the storage
 * behind the server takes for a part that is not the last.
 */
export const uploadChunkBytes = 5 * 1024 * 1024;

/** The most chunks that an image has. */
export const maxUploadChunks = Math.ceil(maxImageBytes / uploadChunkBytes);

/** How many chunks a file of `size` bytes goes in. */
export const uploadChunks = (size: number) =>
  Math.max(1, Math.ceil(size / uploadChunkBytes));

/** Where the chunk `number`, from 1, of a file of `size` bytes begins and ends. */
export function uploadChunkRange(
  size: number,
  number: number,
): { start: number; end: number } {
  const start = (number - 1) * uploadChunkBytes;
  return { start, end: Math.min(size, start + uploadChunkBytes) };
}

/**
 * How many requests of an upload a person may make in a minute, all their
 * uploads together: enough for forty images of 20 MiB.
 */
export const uploadRequestsPerMinute = 240;

/**
 * How many bytes of images a workspace holds at most: 2 GiB. Counted are
 * the images that the server still has, as their rows say.
 */
export const maxWorkspaceMediaBytes = 2 * 1024 * 1024 * 1024;

/** The answer to the request that begins an upload, and to every chunk. */
export const uploadStateSchema = z.object({
  chunkBytes: z.number().int().positive(),
  /** The numbers of the chunks that the server has. */
  received: z.array(z.number().int().positive()),
});

export type UploadState = z.infer<typeof uploadStateSchema>;

/** The answer to the request that completes an upload. */
export const uploadCompleteSchema = z.object({
  /** What the row of the image says from now on. */
  status: z.enum(["ready", "failed"]),
});

const mediaPath = (workspaceId: string, mediaId: string) =>
  `/api/workspaces/${workspaceId}/media/${mediaId}`;

/** The address that an image is uploaded to. */
export const mediaUploadPath = (workspaceId: string, mediaId: string) =>
  `${mediaPath(workspaceId, mediaId)}/upload`;

/**
 * The address of the bytes of an image, for whoever is signed in as the
 * owner of the workspace: the image as the server keeps it, or the small
 * picture of it.
 */
export const mediaFilePath = (
  workspaceId: string,
  mediaId: string,
  which: "original" | "thumbnail",
) => `${mediaPath(workspaceId, mediaId)}/${which}`;

/** How long an image stays when it is in no part, in milliseconds: a day. */
export const unattachedMs = 24 * 60 * 60 * 1000;

/**
 * How long an upload may take, in milliseconds: a week from when its row
 * was made. The row is `failed` after that.
 */
export const uploadLifetimeMs = 7 * 24 * 60 * 60 * 1000;

/**
 * How long the server keeps the bytes of an image after the last post
 * that it is in was sent everywhere, in milliseconds: 30 days. The small
 * picture stays.
 */
export const originalLifetimeMs = 30 * 24 * 60 * 60 * 1000;
