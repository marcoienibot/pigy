import { imageInfo, type SimImageType } from "../world/index.ts";
import type { Caller } from "./api.ts";
import { apiError, json } from "./http.ts";
import type { Instance, MastodonAccount, State } from "./state.ts";

/**
 * The media of Mastodon's API, as far as images go: methods/media of its
 * documentation and entities/MediaAttachment, with what the code says
 * where the documentation is silent: app/models/media_attachment.rb,
 * app/controllers/api/v2/media_controller.rb and
 * app/services/post_status_service.rb.
 *
 * An image is uploaded by itself, and then named in the status that it
 * is in. Until then it is its author's alone, and after a day without a
 * status it is gone.
 */

/** A file that an account has uploaded to its instance. */
export type MediaAttachment = {
  id: string;
  domain: string;
  accountId: string;
  /** The name of the bytes in the blobs of the world. */
  blob: string;
  type: SimImageType;
  width: number;
  height: number;
  size: number;
  description: string;
  /** In milliseconds since the epoch. */
  createdAt: number;
  /** The status that it is in, or null while it is in none. */
  statusId: string | null;
  /**
   * How often the instance is still asked about it before it has done
   * with the file: 0 for one that is processed.
   */
  processing: number;
};

/** The types of image that the simulated instances take. */
export const supportedImageTypes: readonly SimImageType[] = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

/** What the simulated instances take of an image, as Mastodon ships. */
export const mediaLimits = {
  imageSizeLimit: 16_777_216,
  imageMatrixLimit: 33_177_600,
  descriptionLimit: 1500,
  maxAttachments: 4,
} as const;

// From the code: what is in no status after a day is deleted.
const unattachedLifetimeMs = 24 * 60 * 60 * 1000;

/** The attachment with this ID on this instance, if it is still there. */
export function findMedia(
  state: State,
  instance: Instance,
  id: string,
): MediaAttachment | undefined {
  const media = state.media.get(id);
  if (media?.domain !== instance.domain) return undefined;
  if (
    media.statusId === null &&
    state.world.now().getTime() - media.createdAt >= unattachedLifetimeMs
  ) {
    return undefined;
  }
  return media;
}

/** entities/MediaAttachment. `url` is null while the file is processed. */
export function mediaJson(media: MediaAttachment) {
  const url = `https://${media.domain}/system/media_attachments/files/${media.id}/original`;
  const size = {
    width: media.width,
    height: media.height,
    size: `${media.width}x${media.height}`,
    aspect: media.width / media.height,
  };
  return {
    id: media.id,
    // GUESS: a GIF becomes a video without sound, which Mastodon calls
    // "gifv", whether or not it moves.
    type: media.type === "image/gif" ? "gifv" : "image",
    url: media.processing > 0 ? null : url,
    preview_url: media.processing > 0 ? null : `${url}/small`,
    remote_url: null,
    text_url: null,
    meta: { original: size, small: size },
    description: media.description === "" ? null : media.description,
    blurhash: "UBL_:rOpGG-oBUNG,qRj2so|=eE1w^n4S5NH",
  };
}

/**
 * `POST /api/v2/media`: takes a file. The answer is 200 with the
 * attachment for a file that the instance has done with, and 202 for one
 * that it still works on, whose `url` is null until it has.
 *
 * GUESS: which files Mastodon works on after it has answered. Its code
 * does so for video and audio, and makes a video of a GIF. Here a GIF is
 * the file that is not done at once, so that a client has to wait for one
 * image at least.
 */
export async function uploadMedia(
  state: State,
  instance: Instance,
  request: Request,
  { account }: Caller & { account: MastodonAccount },
): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return apiError(422, "Validation failed: File can't be blank");
  }
  const file = form.get("file");
  if (file === null || typeof file === "string") {
    return apiError(422, "Validation failed: File can't be blank");
  }
  const refused = ["thumbnail", "focus"].find((name) => form.has(name));
  if (refused) {
    return apiError(422, `The simulated Mastodon does not have ${refused} yet`);
  }
  const description = form.get("description");
  if (description !== null && typeof description !== "string") {
    return apiError(422, "Validation failed: Description is invalid");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  // What the file is, by its bytes: the type that a client names is not
  // what Mastodon goes by.
  const info = imageInfo(bytes);
  if (!info || !supportedImageTypes.includes(info.type)) {
    return apiError(422, "Validation failed: File content type is invalid");
  }
  if (bytes.length > mediaLimits.imageSizeLimit) {
    return apiError(
      422,
      "Validation failed: File file size must be less than 16 MB",
    );
  }
  if (info.width * info.height > mediaLimits.imageMatrixLimit) {
    return apiError(
      422,
      `Validation failed: File ${info.width}x${info.height} images are not supported`,
    );
  }
  if ([...(description ?? "")].length > mediaLimits.descriptionLimit) {
    return apiError(
      422,
      `Validation failed: Description is too long (maximum is ${mediaLimits.descriptionLimit} characters)`,
    );
  }
  const media: MediaAttachment = {
    id: state.nextId(),
    domain: instance.domain,
    accountId: account.id,
    blob: state.world.blobs.put(bytes),
    ...info,
    size: bytes.length,
    description: description ?? "",
    createdAt: state.world.now().getTime(),
    statusId: null,
    processing: info.type === "image/gif" ? 1 : 0,
  };
  state.media.put(media.id, media);
  return json(media.processing > 0 ? 202 : 200, mediaJson(media));
}

/**
 * `GET /api/v1/media/:id`: an attachment of one's own that is in no
 * status yet: 200 when the instance has done with the file, 206 while it
 * has not.
 */
export function showMedia(
  state: State,
  instance: Instance,
  id: string,
  { account }: Caller & { account: MastodonAccount },
): Response {
  const media = findMedia(state, instance, id);
  // Somebody else's is as good as none, and so is one that is in a
  // status: from the code, which looks among the unattached.
  if (!media || media.accountId !== account.id || media.statusId !== null) {
    return apiError(404, "Record not found");
  }
  if (media.processing > 0) {
    // Done by the next time somebody asks.
    state.media.put(media.id, { ...media, processing: media.processing - 1 });
    return json(206, mediaJson(media));
  }
  return json(200, mediaJson(media));
}

/**
 * The attachments that a new status of `account` names with `ids`, or the
 * error that Mastodon answers with: from
 * app/services/post_status_service.rb, `validate_media!`.
 */
export function attachable(
  state: State,
  instance: Instance,
  account: MastodonAccount,
  ids: unknown,
): MediaAttachment[] | Response {
  if (ids === undefined) return [];
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) {
    return apiError(422, "Validation failed: Media is invalid");
  }
  if (ids.length > mediaLimits.maxAttachments) {
    return apiError(
      422,
      `Cannot attach more than ${mediaLimits.maxAttachments} files`,
    );
  }
  const found = ids.map((id) => findMedia(state, instance, id));
  const own = found.filter(
    (media): media is MediaAttachment =>
      media !== undefined &&
      media.accountId === account.id &&
      media.statusId === null,
  );
  // From the code: the files that are not the account's own, or are in a
  // status already, are not found, and a status that names one is refused.
  if (own.length !== ids.length) {
    return apiError(
      422,
      "Cannot attach files that have not finished processing. Try again in a moment!",
    );
  }
  if (own.some(({ processing }) => processing > 0)) {
    return apiError(
      422,
      "Cannot attach files that have not finished processing. Try again in a moment!",
    );
  }
  return own;
}
