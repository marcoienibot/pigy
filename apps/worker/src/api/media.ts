import {
  type Fetch,
  maxImageBytes,
  networks,
  sandboxImage,
  uuidv7,
} from "@pigy/core";
import type {
  AssetInput,
  assetLimits,
  CreatePostRequest,
  UpdatePostRequest,
} from "@pigy/core/api";
import { publicUrl } from "@pigy/providers";
import { AssetRefused, fetchAsset } from "@pigy/providers/asset";
import { InvalidField } from "../errors.ts";
import { fileWriter, readIn } from "../media/intake.ts";
import { deleteUnder, mediaKeys } from "../media/keys.ts";
import type { ImageTransformer } from "../media/transform.ts";
import { WorldHostMissing } from "../sim/world.ts";
import type { TakenImage, TakenImages } from "../workspace/api.ts";

/**
 * How the public API takes images in: the file of `POST /media`, and the
 * files at the addresses that a post names. Both are put into the bucket
 * and read there, as the upload of the app is, before the workspace is
 * asked to make their rows: `takeIn` of src/media/intake.ts, from its
 * second half on. So a file that is no image is refused before anything
 * is made, and the row says what the server read, never what a request
 * or an answer said.
 *
 * What a call put into the bucket is the call's to clean up: all of it
 * when the workspace refused the call or answered it as a repeat, and the
 * file as it came when the workspace made the rows. Where the call to the
 * workspace failed, nothing is deleted: the change may have been made,
 * and its rows name what is there.
 */

/** Why a file was not taken, in words for whoever sent it. */
export class FileRefused extends Error {
  override name = "FileRefused";

  constructor(
    message: string,
    /** 413 for a file that is too large, 400 for any other. */
    readonly status: 400 | 413 = 400,
  ) {
    super(message);
  }
}

/** What the API takes an image in with. */
export type Intake = {
  bucket: R2Bucket;
  transformer: ImageTransformer;
  workspaceId: string;
  now: Date;
};

const tooLarge = () =>
  new FileRefused(
    `The file is larger than ${maxImageBytes / 1024 / 1024} MiB.`,
    413,
  );

/**
 * Takes in the file that `feed` hands over, a piece at a time, as an
 * image of the workspace: stores it and reads it. Returns the image, for
 * the workspace to make its row, or throws a `FileRefused` and keeps
 * nothing of it. What `feed` throws comes out as it is, and nothing of
 * the file is kept then either.
 */
export async function takeFile(
  intake: Intake,
  feed: (write: (piece: Uint8Array) => Promise<void>) => Promise<void>,
): Promise<TakenImage> {
  const { bucket, transformer, workspaceId } = intake;
  const id = uuidv7(intake.now);
  const writer = fileWriter(bucket, workspaceId, id, maxImageBytes);
  let size: number;
  try {
    await feed(async (piece) => {
      if (!(await writer.write(piece))) throw tooLarge();
    });
    size = await writer.close();
  } catch (error) {
    await writer.abort();
    await dropImages(bucket, workspaceId, [id]);
    throw error;
  }
  if (size === 0) {
    await dropImages(bucket, workspaceId, [id]);
    throw new FileRefused("The body is empty: send the file of an image.");
  }
  try {
    const outcome = await readIn(bucket, transformer, workspaceId, id, size);
    if ("error" in outcome) throw new FileRefused(outcome.error);
    return { id, facts: outcome.facts };
  } catch (error) {
    await dropImages(bucket, workspaceId, [id]);
    throw error;
  }
}

/** Deletes everything that the bucket has of the images `ids`. */
export async function dropImages(
  bucket: R2Bucket,
  workspaceId: string,
  ids: readonly string[],
): Promise<void> {
  for (const id of ids) {
    await deleteUnder(bucket, mediaKeys(workspaceId, id).prefix);
  }
}

/**
 * Deletes the files of the images `ids` as they came, which their rows
 * no longer need: the copy and the small picture stay.
 */
export async function keepImages(
  bucket: R2Bucket,
  workspaceId: string,
  ids: readonly string[],
): Promise<void> {
  await bucket.delete(ids.map((id) => mediaKeys(workspaceId, id).upload));
}

/**
 * Every image that `body` names by its address, with the field of the
 * request that names it, in the order of the fields.
 */
export function addressesOf(
  body: CreatePostRequest | UpdatePostRequest,
): { field: string; url: string }[] {
  const found: { field: string; url: string }[] = [];
  const look = (base: string, assets: AssetInput[] | undefined) => {
    assets?.forEach(({ image }, index) => {
      if (image.url !== undefined) {
        found.push({ field: `${base}.${index}.image.url`, url: image.url });
      }
    });
  };
  look("assets", body.assets);
  body.metadata?.thread?.forEach((part, index) => {
    look(`metadata.thread.${index}.assets`, part.assets);
  });
  for (const service of networks) {
    const own = body.metadata?.[service];
    if (!own) continue;
    look(`metadata.${service}.assets`, own.assets);
    own.thread?.forEach((part, index) => {
      look(`metadata.${service}.thread.${index}.assets`, part.assets);
    });
  }
  return found;
}

/**
 * `url` as pigy would ask it, without what stands after "#", which is
 * the browser's, or null if pigy asks nothing there: `publicUrl`.
 */
function askable(url: string): string | null {
  try {
    const address = new URL(url);
    address.hash = "";
    return publicUrl(address.href);
  } catch {
    return null;
  }
}

/**
 * Fetches the images that `body` names by their addresses, with `fetch`,
 * and takes each in. An address that is named twice is fetched once, and
 * the two name one image. Throws an `InvalidField` for the first that
 * could not be fetched or is no image, and keeps nothing then: a request
 * is carried out as a whole or not at all. `ownHosts` are never asked.
 */
export async function takeAddresses(
  intake: Intake,
  fetch: Fetch,
  body: CreatePostRequest | UpdatePostRequest,
  limits: { readonly [Name in keyof typeof assetLimits]: number },
  ownHosts: readonly string[],
): Promise<TakenImages> {
  const named = addressesOf(body);
  const images: TakenImages = { taken: [], at: {} };
  if (named.length === 0) return images;
  const fields = new Map<string, string>();
  for (const { field, url } of named) {
    if (!fields.has(url)) fields.set(url, field);
  }
  if (fields.size > limits.perRequest) {
    const beyond = [...fields.values()][limits.perRequest] ?? "assets";
    throw new InvalidField(
      beyond,
      `${beyond}: A request names ${limits.perRequest} addresses of images at most. Upload the others with POST /media.`,
    );
  }
  // What no request is sent for is refused before any is: an address
  // that pigy would not ask.
  for (const [url, field] of fields) {
    const address = askable(url);
    if (address === null || ownHosts.includes(new URL(address).host)) {
      throw new InvalidField(
        field,
        `${field}: pigy fetches an image only at an HTTPS address of a public host, without a port.`,
      );
    }
  }

  const waiting = [...fields];
  let refusal: InvalidField | undefined;
  let failure: { error: unknown } | undefined;
  const fetchOne = async ([url, field]: [string, string]) => {
    try {
      const image = await takeFile(intake, (write) =>
        fetchAsset(fetch, url, { ...limits, maxBytes: maxImageBytes }, write, {
          ownHosts,
        }).then(() => {}),
      );
      images.taken.push(image);
      images.at[url] = image.id;
    } catch (error) {
      if (
        error instanceof AssetRefused &&
        error.cause instanceof WorldHostMissing
      ) {
        // An address of the internet, which a sandbox does not reach.
        refusal ??= new InvalidField(
          field,
          `${field}: A sandbox fetches images from its simulated web alone, and it has no host ${error.cause.host}. Try ${sandboxImage}.`,
        );
      } else if (
        error instanceof AssetRefused ||
        error instanceof FileRefused
      ) {
        refusal ??= new InvalidField(field, `${field}: ${error.message}`);
      } else {
        failure ??= { error };
      }
    }
  };
  // A few at a time, and none begins after one has failed.
  await Promise.all(
    Array.from({ length: limits.atOnce }, async () => {
      for (;;) {
        const next = waiting.shift();
        if (!next || refusal || failure) return;
        await fetchOne(next);
      }
    }),
  );
  if (refusal || failure) {
    await dropImages(
      intake.bucket,
      intake.workspaceId,
      images.taken.map(({ id }) => id),
    );
    if (refusal) throw refusal;
    throw failure?.error;
  }
  return images;
}
