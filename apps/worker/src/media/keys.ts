import { idSchema } from "@pigy/core";

/**
 * Where the bytes of an image are in the bucket `MEDIA`. Everything of an
 * image is under one prefix, which the IDs of its workspace and of the
 * image make: nothing has to be stored to find it, and deleting an image
 * is deleting what is under its prefix.
 *
 * - `upload` is the file as the device sent it, while the server puts it
 *   together and reads it. It is deleted once the workspace has been told
 *   how the upload ended: `forgetUpload` of intake.ts.
 * - `original` is the image as pigy keeps it: the picture without what a
 *   camera wrote next to it.
 * - `thumbnail` is the small picture for the lists of the app, which
 *   stays when the original goes.
 * - `variants/<name>` are the smaller images that were made for a
 *   network, each once: `variantName` of @pigy/core names them.
 */
export function mediaKeys(workspaceId: string, mediaId: string) {
  const prefix = `${workspaceId}/${mediaId}/`;
  return {
    prefix,
    upload: `${prefix}upload`,
    original: `${prefix}original`,
    thumbnail: `${prefix}thumbnail`,
    variants: `${prefix}variants/`,
    variant: (name: string) => `${prefix}variants/${name}`,
  };
}

/**
 * What names an image of a post to whoever hands out its bytes: the image
 * of the workspace, and which of its files, `original` or
 * `variants/<name>`. It is the `id` of an image of a `PostContent`.
 */
export const contentImageId = (mediaId: string, file: string) =>
  `${mediaId}/${file}`;

const filePattern = /^(original|variants\/[a-z0-9-]{1,60})$/;

/**
 * The key in the bucket of what `id` names in `workspaceId`, or undefined
 * if `id` is not the name of a file that is published: nothing else is
 * read through it, whatever it says.
 */
export function contentImageKey(
  workspaceId: string,
  id: string,
): string | undefined {
  const slash = id.indexOf("/");
  const mediaId = id.slice(0, slash);
  const file = id.slice(slash + 1);
  if (slash < 0 || !idSchema.safeParse(mediaId).success) return undefined;
  if (!filePattern.test(file)) return undefined;
  return `${mediaKeys(workspaceId, mediaId).prefix}${file}`;
}

/** Deletes everything that the bucket has under `prefix`. */
export async function deleteUnder(
  bucket: R2Bucket,
  prefix: string,
): Promise<void> {
  for (;;) {
    // What is listed is deleted, so the next list begins anew.
    const listed = await bucket.list({ prefix, limit: 500 });
    if (listed.objects.length === 0) return;
    await bucket.delete(listed.objects.map(({ key }) => key));
    if (!listed.truncated) return;
  }
}
