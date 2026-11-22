import {
  type ContentImage,
  type MediaLimits,
  type PostContent,
  variantFor,
  variantName,
} from "@pigy/core";
import { type MediaSource, ProviderError } from "@pigy/providers";
import { contentImageId, contentImageKey, mediaKeys } from "./keys.ts";
import type { MediaLinks } from "./links.ts";
import {
  type ImageTransformer,
  makeVariant,
  VariantFailed,
} from "./transform.ts";

/**
 * The images of a delivery as its network gets them. An image that the
 * network takes as it is goes out as the workspace keeps it. Of one that
 * has more bytes or pixels than the network takes, or is of a type that
 * it does not take, a smaller one is made, `variantFor` of @pigy/core,
 * once for the image and the limit, and kept in the bucket next to the
 * original: a second delivery to a network with the same limits, and a
 * step that is run again, find it there.
 */

/** An image of a post is not in the bucket, or nothing can be made of it. */
export class ImageUnavailable extends Error {}

const goneMessage =
  "pigy no longer keeps an image of this post: it lets go of an image some time after its post was sent.";

/**
 * The image `image` of the workspace `workspaceId` as an account with
 * `limits` gets it: the image itself, or the smaller one, which is made
 * if the bucket does not have it. What comes back names the file that is
 * published and says what it is.
 *
 * Throws `ImageUnavailable`, with words for the person, for an image
 * whose bytes are gone and for one that cannot be brought within the
 * limits. Whatever else is thrown is the bucket's or the transformer's
 * own failure, and worth another try.
 */
export async function imageFor(
  bucket: R2Bucket,
  transformer: ImageTransformer,
  workspaceId: string,
  limits: MediaLimits,
  image: ContentImage,
): Promise<ContentImage> {
  const [mediaId = ""] = image.id.split("/");
  const keys = mediaKeys(workspaceId, mediaId);
  const variant = variantFor(limits, image);
  const { missing: _, ...published } = image;
  if (!variant) {
    if (!(await bucket.head(keys.original))) {
      throw new ImageUnavailable(goneMessage);
    }
    return published;
  }
  const name = variantName(variant);
  const key = keys.variant(name);
  const made = await bucket.head(key);
  const facts = made?.customMetadata;
  if (made && facts?.type && facts.width && facts.height) {
    return {
      ...published,
      id: contentImageId(mediaId, `variants/${name}`),
      type: facts.type as ContentImage["type"],
      size: made.size,
      width: Number(facts.width),
      height: Number(facts.height),
      animated: false,
    };
  }
  let result: Awaited<ReturnType<typeof makeVariant>>;
  try {
    result = await makeVariant(
      transformer,
      async () => {
        const original = await bucket.get(keys.original);
        if (!original) throw new ImageUnavailable(goneMessage);
        return original.body;
      },
      image,
      variant,
    );
  } catch (error) {
    if (error instanceof VariantFailed) {
      throw new ImageUnavailable(
        "pigy could not make an image small enough for this network of one of the images of the post.",
      );
    }
    throw error;
  }
  const { bytes, facts: found } = result;
  await bucket.put(key, bytes, {
    httpMetadata: { contentType: found.type },
    // What the image is, so that it is not read again to find out.
    customMetadata: {
      type: found.type,
      width: String(found.width),
      height: String(found.height),
    },
  });
  return {
    ...published,
    id: contentImageId(mediaId, `variants/${name}`),
    type: found.type,
    size: found.size,
    width: found.width,
    height: found.height,
    animated: false,
  };
}

/** The images of every part of `content`, each as `imageFor` has it. */
export async function imagesFor(
  bucket: R2Bucket,
  transformer: ImageTransformer,
  workspaceId: string,
  limits: MediaLimits,
  content: PostContent,
  /** How many of the first parts are published and need nothing. */
  published: number,
): Promise<ContentImage[][]> {
  const images: ContentImage[][] = [];
  for (const [index, part] of content.parts.entries()) {
    const ofPart: ContentImage[] = [];
    // One after the other: each is a picture that is decoded.
    for (const image of index < published ? [] : (part.media ?? [])) {
      ofPart.push(
        await imageFor(bucket, transformer, workspaceId, limits, image),
      );
    }
    images.push(ofPart);
  }
  return images;
}

/**
 * Where the adapter of a network reads the images of a delivery of
 * `workspaceId` from: the bucket, by the names that the content has for
 * them, and nothing else of it. `link` signs an address at `origin`, the
 * address of the app as the network reaches it, or fails where this pigy
 * does not know that address or has nothing to sign with.
 */
export function mediaSource(
  bucket: R2Bucket,
  workspaceId: string,
  links: MediaLinks | undefined,
  origin: string | undefined,
  now: () => Date,
): MediaSource {
  const keyOf = (id: string) => {
    const key = contentImageKey(workspaceId, id);
    // No image of a content is named otherwise: a bug of the caller's.
    if (!key) throw new Error("This is not the name of an image of a post");
    return key;
  };
  return {
    async read(id) {
      const file = await bucket.get(keyOf(id));
      if (!file) throw new ProviderError("fail", goneMessage);
      return new Uint8Array(await file.arrayBuffer());
    },
    async link(id) {
      keyOf(id);
      if (!links || origin === undefined) {
        throw new ProviderError(
          "fail",
          "This pigy cannot hand an image to this network: it does not know its own address. Whoever runs it sets APP_URL.",
        );
      }
      return links.sign(origin, workspaceId, id, now());
    },
  };
}
