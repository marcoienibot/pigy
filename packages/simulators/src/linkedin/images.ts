import { imageInfo, type SimImage, simulatedSecret } from "../world/index.ts";
import { apiError, empty, json } from "./http.ts";
import type { LinkedInImage, LinkedInMember, State } from "./state.ts";

/**
 * The Images API of LinkedIn, as an application uses it to post images
 * for a member: "Images API", "Posts API", "MultiImage API". Written
 * without access to those pages, from what its author knew of them, so
 * much of it is a GUESS for a run against the real LinkedIn to settle:
 * PLAN.md section 19.
 *
 * An image is made in two requests. `initializeUpload` makes it, empty,
 * and hands out the address that its bytes go to, and the URN that a
 * post names it by. The bytes are put there, with the token of the
 * member: GUESS, as LinkedIn's example does. LinkedIn then works on them
 * for a while, and an image that it could not read says so: its status
 * goes from `WAITING_UPLOAD` to `PROCESSING` and to `AVAILABLE` or
 * `PROCESSING_FAILED`. A post names images that are available, one in
 * `content.media`, or two to twenty in `content.multiImage`, each with
 * its `altText`.
 */

/** How long LinkedIn works on an image when a fault makes it slow. */
export const slowProcessingMs = 30_000;

/**
 * The most bytes of an image that LinkedIn takes. GUESS: LinkedIn
 * documents none for the Images API, and this is what its upload has
 * been seen to take.
 */
export const maxImageBytes = 8 * 1024 * 1024;

/** The most pixels of an image. Documented for the Images API. */
export const maxImagePixels = 36_152_320;

/** The types of image that LinkedIn takes. Documented: JPG, PNG and GIF. */
const takenTypes = ["image/jpeg", "image/png", "image/gif"];

/**
 * The longest description of an image, `altText`. GUESS: what LinkedIn's
 * documentation of the Posts API has been read to say.
 */
export const maxAltLength = 4086;

/** How many images a post of several names: documented, two to twenty. */
export const multiImageRange = { min: 2, max: 20 } as const;

/** Where the bytes of an image go: under the host where members sign in. */
export const uploadPath = "/dms-uploads/";

/** The status of an image, as LinkedIn names it. */
export function statusOf(state: State, image: LinkedInImage) {
  if (image.file === null) return "WAITING_UPLOAD";
  if ("failed" in image.file) return "PROCESSING_FAILED";
  return state.world.now().getTime() < image.readyAt
    ? "PROCESSING"
    : "AVAILABLE";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * `POST /rest/images?action=initializeUpload`: makes an image of the
 * member, without bytes, and says where they go.
 */
export async function initializeUpload(
  state: State,
  request: Request,
  member: LinkedInMember,
): Promise<Response> {
  if (
    !(request.headers.get("Content-Type") ?? "").startsWith("application/json")
  ) {
    return apiError(415, "The body of the request must be application/json");
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = undefined;
  }
  const asked = isRecord(body) ? body.initializeUploadRequest : undefined;
  if (
    !isRecord(body) ||
    Object.keys(body).length !== 1 ||
    !isRecord(asked) ||
    Object.keys(asked).some((field) => field !== "owner")
  ) {
    return apiError(
      422,
      "The body of an initializeUpload is { initializeUploadRequest: { owner } }",
    );
  }
  const { owner } = asked;
  if (typeof owner !== "string" || !owner.startsWith("urn:li:")) {
    return apiError(422, "initializeUploadRequest/owner must be a URN");
  }
  if (owner.startsWith("urn:li:organization:")) {
    return apiError(
      400,
      "The simulated LinkedIn uploads for members only, not for organizations",
    );
  }
  // A token uploads for its member and for nobody else.
  if (owner !== `urn:li:person:${member.id}`) {
    return apiError(403, "Not enough permissions to upload for this owner", {
      serviceErrorCode: 100,
      code: "ACCESS_DENIED",
    });
  }
  const now = state.world.now().getTime();
  // An ID in the form of LinkedIn's: letters and digits that say nothing.
  const key = `D4E22AQ${simulatedSecret().slice(-12).replaceAll(/[-_]/g, "x")}`;
  const image: LinkedInImage = {
    id: `urn:li:image:${key}`,
    ownerId: member.id,
    uploadToken: simulatedSecret(),
    createdAt: now,
    file: null,
    readyAt: now,
  };
  state.images.put(image.id, image);
  return json(200, {
    value: {
      // GUESS: for how long the address takes the bytes.
      uploadUrlExpiresAt: now + 24 * 60 * 60 * 1000,
      uploadUrl: `https://www.linkedin.com${uploadPath}${key}?ut=${image.uploadToken}`,
      image: image.id,
    },
  });
}

/**
 * `PUT` at the address that `initializeUpload` handed out: the bytes of
 * the image, once. `slow` is a fault: LinkedIn takes its time to work on
 * them.
 */
export async function uploadBytes(
  state: State,
  request: Request,
  member: LinkedInMember,
  slow: boolean,
): Promise<Response> {
  const url = new URL(request.url);
  const key = url.pathname.slice(uploadPath.length);
  const image = state.images.get(`urn:li:image:${key}`);
  // GUESS: an address that LinkedIn did not hand out, or one whose token
  // is not the image's, is one that it has nothing at.
  if (!image || url.searchParams.get("ut") !== image.uploadToken) {
    return apiError(404, "Resource not found");
  }
  if (image.ownerId !== member.id) {
    return apiError(403, "Not enough permissions to upload this image", {
      serviceErrorCode: 100,
      code: "ACCESS_DENIED",
    });
  }
  if (image.file !== null) {
    // GUESS: the address takes the bytes of an image once.
    return apiError(400, "The image has been uploaded already");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length === 0) return apiError(400, "The upload has no bytes");
  if (bytes.length > maxImageBytes) {
    // GUESS: refused at once, and not by its processing.
    return apiError(413, "The image is larger than LinkedIn takes");
  }
  const info = imageInfo(bytes);
  const now = state.world.now().getTime();
  let file: LinkedInImage["file"];
  if (!info || !takenTypes.includes(info.type)) {
    file = { failed: "The file is no JPG, PNG or GIF" };
  } else if (info.width * info.height > maxImagePixels) {
    file = { failed: "The image has more pixels than LinkedIn takes" };
  } else {
    file = {
      blob: state.world.blobs.put(bytes),
      type: info.type,
      width: info.width,
      height: info.height,
      size: bytes.length,
    };
  }
  state.images.put(image.id, {
    ...image,
    file,
    readyAt: slow ? now + slowProcessingMs : now,
  });
  return empty(201);
}

/** `GET /rest/images/{urn}`: how an image of the member stands. */
export function readImage(
  state: State,
  id: string,
  member: LinkedInMember,
): Response {
  const image = state.images.get(id);
  if (!image) return apiError(404, `Could not find entity ${id}`);
  if (image.ownerId !== member.id) {
    return apiError(403, "Not enough permissions to read this image", {
      serviceErrorCode: 100,
      code: "ACCESS_DENIED",
    });
  }
  return json(200, {
    id: image.id,
    owner: `urn:li:person:${image.ownerId}`,
    status: statusOf(state, image),
  });
}

/**
 * The images that `content` of a post names, as the post is to show them,
 * or what is wrong with them: `media` for one, `multiImage` for several.
 * Null where `content` names no image.
 */
export function imagesOf(
  state: State,
  content: Record<string, unknown>,
  member: LinkedInMember,
): SimImage[] | { error: string; status: number } | null {
  let named: unknown[];
  if ("media" in content) {
    named = [content.media];
  } else if ("multiImage" in content) {
    const { multiImage } = content;
    if (!isRecord(multiImage) || !Array.isArray(multiImage.images)) {
      return { status: 422, error: "content/multiImage/images is required" };
    }
    if (Object.keys(multiImage).some((field) => field !== "images")) {
      return {
        status: 400,
        error:
          "The simulated LinkedIn takes the images of a multiImage and nothing else",
      };
    }
    named = multiImage.images;
    if (
      named.length < multiImageRange.min ||
      named.length > multiImageRange.max
    ) {
      return {
        status: 422,
        error: `A multiImage has ${multiImageRange.min} to ${multiImageRange.max} images`,
      };
    }
  } else {
    return null;
  }
  const images: SimImage[] = [];
  for (const entry of named) {
    if (!isRecord(entry) || typeof entry.id !== "string") {
      return { status: 422, error: "An image of a post is { id, altText }" };
    }
    const unknown = Object.keys(entry).find(
      (field) => !["id", "altText", "title"].includes(field),
    );
    if (unknown !== undefined) {
      return { status: 422, error: `An image of a post has no "${unknown}"` };
    }
    const { id, altText = "" } = entry;
    if (typeof altText !== "string") {
      return { status: 422, error: "altText must be a string" };
    }
    if (altText.length > maxAltLength) {
      return {
        status: 422,
        error: `altText is ${altText.length} characters long, and the limit is ${maxAltLength}`,
      };
    }
    const image = state.images.get(id);
    // GUESS: an image of somebody else's is one that the author does not
    // have, and is refused the same way.
    if (!image || image.ownerId !== member.id) {
      return { status: 422, error: `The image ${id} does not exist` };
    }
    const status = statusOf(state, image);
    if (status !== "AVAILABLE" || !image.file || "failed" in image.file) {
      // GUESS: LinkedIn refuses a post with an image that it is not done
      // with, as it documents for a video.
      return {
        status: 422,
        error: `The image ${id} is not available: it is ${status}`,
      };
    }
    images.push({ ...image.file, alt: altText });
  }
  return images;
}
