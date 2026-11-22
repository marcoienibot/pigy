import {
  chunksOf,
  type ImageFacts,
  type ImageType,
  scanImage,
  type Variant,
} from "@pigy/core";

/**
 * What makes one image of another: smaller, or of another type. In front
 * of the Images binding of Cloudflare, `imagesTransformer`, which is the
 * only thing here that decodes a picture. Everything else of pigy reads
 * the layout of a file and nothing of its pixels.
 */
export type ImageTransformer = {
  /**
   * `image` as a picture of `type` that is `width` by `height` at most,
   * in the shape that it has: never larger than it is. A picture that
   * moves comes out still. What a camera wrote next to the picture does
   * not come out, and a picture that says it lies on its side comes out
   * turned. Throws for a file that it cannot draw.
   */
  make(
    image: ReadableStream<Uint8Array>,
    options: {
      type: ImageType;
      width: number;
      height: number;
      quality: number;
    },
  ): Promise<Uint8Array>;
};

/** The transformer of this deployment: the binding `IMAGES`. */
export function imagesTransformer(images: ImagesBinding): ImageTransformer {
  return {
    async make(image, { type, width, height, quality }) {
      const made = await images
        .input(image)
        .transform({ width, height, fit: "scale-down" })
        .output({ format: type, quality, anim: false });
      return new Uint8Array(await made.response().arrayBuffer());
    },
  };
}

/** An image that was made of another, with what it is. */
export type MadeImage = { bytes: Uint8Array; facts: ImageFacts };

/** No image could be made that the network takes. */
export class VariantFailed extends Error {}

/**
 * How an image is tried to be brought within a number of bytes: each a
 * part of its side and a quality, from the image at its size to an
 * eighth of its side.
 */
const attempts = [
  { scale: 1, quality: 85 },
  { scale: 1, quality: 70 },
  { scale: 0.75, quality: 75 },
  { scale: 0.5, quality: 75 },
  { scale: 0.35, quality: 70 },
  { scale: 0.25, quality: 60 },
  { scale: 0.125, quality: 50 },
] as const;

/**
 * Makes the image that `variant` describes of the image that `open`
 * opens, which is `width` by `height`: of its type, within its pixels and
 * within its bytes. The original is read anew for every try, as a
 * stream, and what is made is as large as the network takes at most.
 *
 * A PNG has no quality to lower, so one that stays too large at every
 * size becomes a JPEG, which every network takes.
 */
export async function makeVariant(
  transformer: ImageTransformer,
  open: () => Promise<ReadableStream<Uint8Array>>,
  image: { width: number; height: number },
  variant: Variant,
): Promise<MadeImage> {
  // Within the pixels first: the side by the root of what the area is
  // over by.
  const within =
    variant.maxPixels === null
      ? 1
      : Math.min(
          1,
          Math.sqrt(variant.maxPixels / (image.width * image.height)),
        );
  for (const type of new Set<ImageType>([variant.type, "image/jpeg"])) {
    let before: number | null = null;
    for (const { scale, quality } of attempts) {
      // A PNG is the same at every quality.
      if (type === "image/png" && scale === before) continue;
      before = scale;
      const bytes = await transformer.make(await open(), {
        type,
        width: Math.max(1, Math.floor(image.width * within * scale)),
        height: Math.max(1, Math.floor(image.height * within * scale)),
        quality,
      });
      if (bytes.length > variant.maxBytes) continue;
      // What was made is read like every image: what it is is not taken
      // from what was asked for.
      const facts = await scanImage(chunksOf(new Blob([bytes]).stream()));
      if (
        variant.maxPixels !== null &&
        facts.width * facts.height > variant.maxPixels
      ) {
        continue;
      }
      return { bytes, facts };
    }
  }
  throw new VariantFailed(
    "No smaller image could be made that the network takes",
  );
}

/** The longest side of the small picture that the lists of the app show. */
export const thumbnailSide = 480;

/** The small picture of an image, for the lists of the app: a WebP. */
export async function makeThumbnail(
  transformer: ImageTransformer,
  image: ReadableStream<Uint8Array>,
): Promise<MadeImage> {
  const bytes = await transformer.make(image, {
    type: "image/webp",
    width: thumbnailSide,
    height: thumbnailSide,
    quality: 75,
  });
  return {
    bytes,
    facts: await scanImage(chunksOf(new Blob([bytes]).stream())),
  };
}
