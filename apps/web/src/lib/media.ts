import {
  type ContentImage,
  chunksOf,
  type ImageFacts,
  ImageRefused,
  imageTypes,
  inReadingOrder,
  type Limits,
  type MutatorArgs,
  type MutatorName,
  maxImageBytes,
  maxImagesPerPart,
  mediaFilePath,
  mediaLimitsOf,
  type Row,
  mediaRowLimits as rowLimits,
  scanImage,
  type Tables,
  uuidv7,
  variantFor,
} from "@pigy/core";
import { fetchImage, uploadRequest } from "@/lib/api";
import { networkInfo } from "@/lib/networks";
import { indexedDbFiles } from "@/lib/upload-files";
import { Uploads } from "@/lib/uploads";

/**
 * The images of the parts of a post, as a screen shows them: what the
 * synced tables `media` and `part_media` say, and what the editor does
 * with a file. SYNC.md, "Images", has the rows.
 */

/** An image in a part. */
export type PartImage = {
  /** The ID of the row that puts the image into the part. */
  id: string;
  /** What it shows, for whoever cannot see it. */
  alt: string;
  /**
   * The image, or undefined if its row is gone: the server has deleted
   * an image that was in no part for a day, and an Undo came later.
   */
  media: Row<"media"> | undefined;
};

/** The images of every part that has some, in the order they are shown in. */
export type PartImages = ReadonlyMap<string, readonly PartImage[]>;

const none: readonly PartImage[] = [];

// The list that was made for each part the last time, with the rows that
// it was made of: a part whose images have not changed keeps its list,
// so that the field of the part does not render for a key in another.
const lists = new Map<
  string,
  { rows: readonly unknown[]; images: readonly PartImage[] }
>();

export function selectPartImages(tables: Tables): PartImages {
  const byPart = new Map<string, Row<"part_media">[]>();
  for (const attached of tables.part_media.values()) {
    const ofPart = byPart.get(attached.partId);
    if (ofPart) ofPart.push(attached);
    else byPart.set(attached.partId, [attached]);
  }
  const all = new Map<string, readonly PartImage[]>();
  for (const [partId, attached] of byPart) {
    const ordered = inReadingOrder(attached);
    // A row that has not changed is the same object in every view.
    const rows = ordered.flatMap((row) => [row, tables.media.get(row.mediaId)]);
    const before = lists.get(partId);
    if (
      before &&
      before.rows.length === rows.length &&
      before.rows.every((row, index) => row === rows[index])
    ) {
      all.set(partId, before.images);
      continue;
    }
    const images = ordered.map(({ id, alt, mediaId }) => ({
      id,
      alt,
      media: tables.media.get(mediaId),
    }));
    lists.set(partId, { rows, images });
    all.set(partId, images);
  }
  // The lists of parts that are gone, or have no image left, go too.
  for (const partId of lists.keys()) {
    if (!all.has(partId)) lists.delete(partId);
  }
  return all;
}

/**
 * The images of every part as `validateContent` judges them, by the ID
 * of the part: what `compose` of lib/publish.ts takes.
 */
export function contentImagesOf(
  images: PartImages,
): ReadonlyMap<string, readonly ContentImage[]> {
  return new Map(
    [...images].map(([partId, ofPart]) => [partId, ofPart.map(contentImage)]),
  );
}

/** The images of the part `partId`. */
export const imagesOf = (images: PartImages, partId: string) =>
  images.get(partId) ?? none;

/** The IDs of the images of the workspace that are on their way. */
export function selectUploading(tables: Tables): string {
  // As one text, which is the same from one change of the copy to the
  // next unless an upload has begun or ended.
  return [...tables.media.values()]
    .filter(({ status }) => status === "uploading")
    .map(({ id }) => id)
    .sort()
    .join(" ");
}

/**
 * An image of a part as `validateContent` of @pigy/core judges it for an
 * account: what its row says of it, and whether it can go out as things
 * are.
 */
export function contentImage({ id, alt, media }: PartImage): ContentImage {
  const missing =
    !media || media.originalGoneAt !== null
      ? "gone"
      : media.status === "ready"
        ? undefined
        : media.status;
  return {
    id,
    type: media?.type ?? "image/jpeg",
    size: media?.size ?? 1,
    width: media?.width ?? 1,
    height: media?.height ?? 1,
    ...(media?.animated && { animated: true }),
    alt,
    ...(missing && { missing }),
  };
}

/**
 * What the editor says under the images of a part besides what an
 * account would refuse: reminders, and what a network will make of the
 * images, none of which keeps the post from going out.
 *
 * `limits` are those of the accounts that get the text, and `hasLink`
 * says whether the text of the part has a link.
 */
export function imageNotes(
  images: readonly PartImage[],
  limits: readonly Limits[],
  hasLink: boolean,
): string[] {
  if (images.length === 0) return [];
  const notes: string[] = [];
  const undescribed = images.filter(({ alt }) => alt.trim() === "").length;
  if (undescribed > 0) {
    notes.push(
      images.length === 1
        ? "The image has no description. People who use a screen reader hear nothing of it."
        : `${undescribed === images.length ? "The images have" : undescribed === 1 ? "One image has" : `${undescribed} images have`} no description. People who use a screen reader hear nothing of ${undescribed === 1 ? "it" : "them"}.`,
    );
  }
  const names = (networks: Limits["network"][]) =>
    [...new Set(networks)]
      .sort()
      .map((network) => networkInfo[network].label)
      .join(" and ");
  // A network that shows the card of a link only if it is sent one is
  // sent the images in its place: a post has one or the other.
  const noCard = limits
    .map(({ network }) => network)
    .filter((network) => network === "bluesky" || network === "linkedin");
  if (hasLink && noCard.length > 0) {
    notes.push(
      `${names(noCard)} ${new Set(noCard).size === 1 ? "shows" : "show"} the images and no card for the link: a post has one or the other there.`,
    );
  }
  const still = limits.filter((of) =>
    images.some(
      ({ media }) =>
        media?.animated &&
        variantFor(mediaLimitsOf(of), media) !== null &&
        !mediaLimitsOf(of).animated,
    ),
  );
  if (still.length > 0) {
    notes.push(
      `An image that moves is a still picture on ${names(still.map(({ network }) => network))}.`,
    );
  }
  const smaller = limits.filter((of) =>
    images.some(
      ({ media }) =>
        media &&
        !media.animated &&
        variantFor(mediaLimitsOf(of), media) !== null,
    ),
  );
  if (smaller.length > 0) {
    notes.push(
      `pigy makes a smaller image for ${names(smaller.map(({ network }) => network))}, which ${new Set(smaller.map(({ network }) => network)).size === 1 ? "takes" : "take"} less than this one has.`,
    );
  }
  return notes;
}

/** What a file is, as the device reads it, or why pigy does not take it. */
export async function readFile(
  file: Blob,
): Promise<{ facts: ImageFacts } | { refused: string }> {
  if (file.size > maxImageBytes) {
    return {
      refused: `is larger than ${maxImageBytes / 1024 / 1024} MB, which is the most that pigy takes`,
    };
  }
  try {
    return { facts: await scanImage(chunksOf(file.stream())) };
  } catch (error) {
    if (!(error instanceof ImageRefused)) throw error;
    switch (error.code) {
      case "not_an_image":
        return { refused: "is not a JPEG, PNG, WebP or GIF image" };
      case "damaged":
        return { refused: "is damaged: it is not a complete image" };
      case "too_many_pixels":
        return { refused: "has more pixels than pigy takes" };
      case "too_large":
        return { refused: "is larger than pigy takes" };
    }
  }
}

/** The types of file that the picker of the device offers. */
export const acceptedTypes = imageTypes.join(",");

type Mutate = <Name extends MutatorName>(
  name: Name,
  args: MutatorArgs<Name>,
) => void;

/**
 * Puts `files` into the part `partId`, which has `has` images: makes the
 * row of each with what the device reads in it, puts it into the part,
 * and hands the file to the uploads of the tab. Returns what to tell the
 * person of the files that were not taken, one line for each.
 */
export async function attachFiles(
  files: readonly File[],
  partId: string,
  has: number,
  workspaceId: string,
  mutate: Mutate,
  uploads: Uploads,
): Promise<string[]> {
  const refusals: string[] = [];
  let room = maxImagesPerPart - has;
  for (const file of files) {
    const name = file.name || "The image";
    if (room <= 0) {
      refusals.push(
        `${name} was not added: a part has ${maxImagesPerPart} images at most.`,
      );
      continue;
    }
    const read = await readFile(file);
    if ("refused" in read) {
      refusals.push(`${name} ${read.refused}.`);
      continue;
    }
    room -= 1;
    const { type, width, height, animated } = read.facts;
    const mediaId = uuidv7(new Date());
    mutate("media.create", {
      id: mediaId,
      name: file.name.slice(0, rowLimits.nameLength),
      type,
      size: file.size,
      width,
      height,
      animated,
    });
    mutate("media.attach", {
      id: uuidv7(new Date()),
      partId,
      mediaId,
      alt: "",
    });
    await uploads.add(workspaceId, mediaId, file);
  }
  return refusals;
}

/**
 * Puts the images `images` into the part `partId` again, in their order:
 * for an Undo that brings a part or a draft back, and for the text of
 * an account, which begins with the images of the post's.
 */
export function attachAgain(
  mutate: Mutate,
  partId: string,
  images: readonly PartImage[],
): void {
  for (const { alt, media } of images) {
    // An image whose row is gone has nothing to come back.
    if (!media) continue;
    mutate("media.attach", {
      id: uuidv7(new Date()),
      partId,
      mediaId: media.id,
      alt,
    });
  }
}

const uploadsOf = new Map<string, Uploads>();

/** The uploads of this tab for the person `userId`. */
export function uploadsFor(userId: string): Uploads {
  let uploads = uploadsOf.get(userId);
  if (!uploads) {
    uploads = new Uploads({
      api: uploadRequest,
      files: indexedDbFiles(userId),
      schedule: (run, ms) => {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      },
    });
    uploadsOf.set(userId, uploads);
  }
  return uploads;
}

// The small pictures that the tab has fetched, by the address of each.
// In the memory of the page and nowhere else: an image of a workspace is
// somebody's, and the service worker keeps none.
const fetched = new Map<string, Promise<string>>();

/**
 * An address of the small picture of an image of `workspaceId`, for a
 * picture on the page: fetched once in a tab.
 */
export function thumbnailUrl(
  workspaceId: string,
  mediaId: string,
): Promise<string> {
  const path = mediaFilePath(workspaceId, mediaId, "thumbnail");
  let url = fetched.get(path);
  if (!url) {
    url = fetchImage(path).then((blob) => URL.createObjectURL(blob));
    fetched.set(path, url);
    // One that failed is asked for again the next time.
    url.catch(() => fetched.delete(path));
  }
  return url;
}

/** The same for an image of a post of the sandbox, by its address. */
export function fetchedUrl(path: string): Promise<string> {
  let url = fetched.get(path);
  if (!url) {
    url = fetchImage(path).then((blob) => URL.createObjectURL(blob));
    fetched.set(path, url);
    url.catch(() => fetched.delete(path));
  }
  return url;
}
