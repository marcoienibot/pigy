import { z } from "zod";
import { type ImageType, imageTypes } from "../media/image.ts";
import { countBlueskyCharacters, utf8Length } from "./bluesky.ts";
import type { PostContent } from "./content.ts";
import { countLinkedInCharacters, joinLinkedInParts } from "./linkedin.ts";
import { countMastodonCharacters } from "./mastodon.ts";
import { countThreadsCharacters } from "./threads.ts";

/**
 * What an account accepts in a post. The limits are data, so that they can
 * be stored with a channel and reach the browser, which counts while
 * somebody types. They name their network, because the network decides how
 * a text is counted: `countCharacters` and `validateContent` go by it.
 *
 * A network is added here when its adapter is: its limits as a schema of
 * its own in the union, and its way of counting in `countCharacters`.
 */

/**
 * What an account takes of images. Where an image of a post is more than
 * `maxImageBytes` or `maxImagePixels`, or of a type that is not among
 * `imageTypes`, pigy makes a smaller one for the network, `variantFor`,
 * so none of the three keeps a post from going out. The others do.
 */
export const mediaLimitsSchema = z.strictObject({
  /** The most images in one post. */
  maxImages: z.number().int().positive(),
  /** The most bytes of one image. */
  maxImageBytes: z.number().int().positive(),
  /** The most pixels of one image, width times height, or null for no limit. */
  maxImagePixels: z.number().int().positive().nullable(),
  /** The types that the network takes as they are. JPEG is always one. */
  imageTypes: z.array(z.enum(imageTypes)).min(1),
  /** Whether a picture that moves stays one there. */
  animated: z.boolean(),
  /** The longest description of an image, in characters. */
  maxAltLength: z.number().int().positive(),
  /**
   * How much longer one side of an image may be than the other: 10 for
   * ten to one. Null for no limit.
   */
  maxAspectRatio: z.number().positive().nullable(),
});

export type MediaLimits = z.infer<typeof mediaLimitsSchema>;

/**
 * The limits of an account on Mastodon. They are those of its instance and
 * are read from it, never assumed: instances choose their own.
 */
export const mastodonLimitsSchema = z.strictObject({
  network: z.literal("mastodon"),
  /** The most characters in one post, counted the way Mastodon counts. */
  maxCharacters: z.number().int().positive(),
  /** What every link counts as, however long it is. */
  charactersPerUrl: z.number().int().nonnegative(),
  /**
   * What the instance takes of images. Left out by limits that were read
   * before pigy asked: `mediaLimitsOf` has what stands in then.
   */
  media: mediaLimitsSchema.optional(),
});

/**
 * The limits of an account on Bluesky. They are the same for every account:
 * the schema of a post sets them, `blueskyMaxCharacters` and
 * `blueskyMaxBytes`. They are data all the same, so that a channel holds
 * the limits that its network had when it was asked.
 */
export const blueskyLimitsSchema = z.strictObject({
  network: z.literal("bluesky"),
  /** The most characters in one post: grapheme clusters. */
  maxCharacters: z.number().int().positive(),
  /**
   * The most bytes that the text of one post takes in UTF-8. A text can be
   * within `maxCharacters` and over this.
   */
  maxBytes: z.number().int().positive(),
  media: mediaLimitsSchema.optional(),
});

/**
 * The limits of an account on LinkedIn. They are the same for every
 * account, `linkedInMaxCharacters`, and data all the same, as those of
 * Bluesky are.
 */
export const linkedInLimitsSchema = z.strictObject({
  network: z.literal("linkedin"),
  /**
   * The most characters in one post, counted the way LinkedIn counts. A
   * thread is one post there, so its parts have to fit together.
   */
  maxCharacters: z.number().int().positive(),
  media: mediaLimitsSchema.optional(),
});

/**
 * The limits of an account on Threads. They are the same for every
 * account, `threadsMaxCharacters`, and data all the same, as those of
 * Bluesky are.
 */
export const threadsLimitsSchema = z.strictObject({
  network: z.literal("threads"),
  /**
   * The most characters in one post, counted the way Threads counts: an
   * emoji as the bytes that it takes.
   */
  maxCharacters: z.number().int().positive(),
  media: mediaLimitsSchema.optional(),
});

export const limitsSchema = z.discriminatedUnion("network", [
  blueskyLimitsSchema,
  linkedInLimitsSchema,
  mastodonLimitsSchema,
  threadsLimitsSchema,
]);

export type Limits = z.infer<typeof limitsSchema>;

const megabyte = 1024 * 1024;

/**
 * What each network takes of images where the limits of an account do not
 * say: on Bluesky, LinkedIn and Threads, where it is the same for every
 * account, and on a Mastodon instance that was asked before pigy read
 * what it says of media.
 *
 * - Mastodon: the defaults of the software. An instance says its own in
 *   `configuration.media_attachments` and `configuration.statuses`.
 * - Bluesky: the lexicon `app.bsky.embed.images` has four images of a
 *   million bytes each. It has no limit for the description: GUESS, the
 *   2000 that Bluesky's own app stops at. A GIF is a still picture in an
 *   image embed: GUESS.
 * - LinkedIn: GUESS, all of it. The Images API documents JPG, PNG and GIF
 *   and 36,152,320 pixels, a description of 4086 characters, and 2 to 20
 *   images in a post of several. The bytes it takes are not documented:
 *   8 MB is what its upload took in practice.
 * - Threads: the documentation of its API has JPEG and PNG, 8 MB, a
 *   shape of ten to one at most, 20 items in a carousel and a
 *   description of 1000 characters.
 */
export const defaultMediaLimits: {
  readonly [Name in Limits["network"]]: MediaLimits;
} = {
  mastodon: {
    maxImages: 4,
    maxImageBytes: 16 * megabyte,
    maxImagePixels: 33_177_600,
    imageTypes: ["image/jpeg", "image/png", "image/gif", "image/webp"],
    animated: true,
    maxAltLength: 1500,
    maxAspectRatio: null,
  },
  bluesky: {
    maxImages: 4,
    maxImageBytes: 1_000_000,
    maxImagePixels: null,
    imageTypes: ["image/jpeg", "image/png", "image/webp"],
    animated: false,
    maxAltLength: 2000,
    maxAspectRatio: null,
  },
  linkedin: {
    maxImages: 20,
    maxImageBytes: 8 * megabyte,
    maxImagePixels: 36_152_320,
    imageTypes: ["image/jpeg", "image/png", "image/gif"],
    animated: true,
    maxAltLength: 4086,
    maxAspectRatio: null,
  },
  threads: {
    maxImages: 20,
    maxImageBytes: 8 * megabyte,
    maxImagePixels: null,
    imageTypes: ["image/jpeg", "image/png"],
    animated: false,
    maxAltLength: 1000,
    maxAspectRatio: 10,
  },
};

/**
 * The networks that pigy does not publish images to yet. A post with an
 * image is not sent to an account of one of them, and `validateContent`
 * says so: PLAN.md section 10 has what is left to build. A network leaves
 * the list when its adapter publishes images.
 */
export const imagesNotPublishedTo: readonly Limits["network"][] = [
  "linkedin",
  "threads",
];

/** What the account of `limits` takes of images. */
export function mediaLimitsOf(limits: Limits): MediaLimits {
  return limits.media ?? defaultMediaLimits[limits.network];
}

/**
 * The image that is made of another for a network: the type to make it
 * in, and what it has to stay within.
 */
export type Variant = {
  type: ImageType;
  maxBytes: number;
  /** Null for no limit. */
  maxPixels: number | null;
};

/**
 * What has to be made of `image` for an account with `limits`, or null if
 * the network takes the image as it is. A picture that moves and has to
 * be made anew is a still one afterwards, and so is one that goes to a
 * network on which nothing moves.
 */
export function variantFor(
  limits: MediaLimits,
  image: {
    type: ImageType;
    size: number;
    width: number;
    height: number;
    animated?: boolean | undefined;
  },
): Variant | null {
  const taken = limits.imageTypes.includes(image.type);
  const still = !image.animated || limits.animated;
  if (
    taken &&
    still &&
    image.size <= limits.maxImageBytes &&
    (limits.maxImagePixels === null ||
      image.width * image.height <= limits.maxImagePixels)
  ) {
    return null;
  }
  // A drawing stays a PNG where that is taken, with its sharp edges and
  // what it lets shine through. Everything else becomes a JPEG, which
  // every network takes: a photo, and whatever the network has no type
  // for. A GIF that is made anew is one picture: a PNG, as it was drawn.
  const type: ImageType =
    (image.type === "image/png" || image.type === "image/gif") &&
    limits.imageTypes.includes("image/png")
      ? "image/png"
      : "image/jpeg";
  return {
    type,
    maxBytes: limits.maxImageBytes,
    maxPixels: limits.maxImagePixels,
  };
}

/** A name for a variant: the same for the same variant, and for no other. */
export function variantName({ type, maxBytes, maxPixels }: Variant): string {
  return `${type.slice("image/".length)}-${maxBytes}-${maxPixels ?? 0}`;
}

/** The length of a description of an image as the networks count it. */
export const countAltCharacters = (alt: string) => [...alt].length;

/** The length of `text` as the network of `limits` counts it. */
export function countCharacters(limits: Limits, text: string): number {
  switch (limits.network) {
    case "bluesky":
      return countBlueskyCharacters(text);
    case "linkedin":
      return countLinkedInCharacters(text);
    case "mastodon":
      return countMastodonCharacters(text, limits.charactersPerUrl);
    case "threads":
      return countThreadsCharacters(text);
  }
}

// What a message calls a network.
const networkNames: { readonly [Name in Limits["network"]]: string } = {
  bluesky: "Bluesky",
  linkedin: "LinkedIn",
  mastodon: "Mastodon",
  threads: "Threads",
};

/**
 * The longest text that pigy publishes to one account, all its parts
 * together, in UTF-16 code units, which is what `String.length` counts.
 * It is no network's limit but pigy's own: the text that a delivery
 * publishes is kept by the platform with the step of the workflow that
 * read it, and a step may return about a megabyte. This is far below
 * that, also when every character is written as six bytes, and far above
 * a thread that anybody reads: a hundred parts of a thousand characters.
 * Only an account whose server takes very long posts can reach it.
 */
export const maxContentLength = 100_000;

/** Something that keeps content from being published to a network. */
export type ContentIssue = {
  /**
   * Which part it is about, counted from 0, or null for what is about
   * the whole text.
   */
  part: number | null;
  /** For people. */
  message: string;
} & (
  | { code: "empty" }
  | { code: "too_long"; characters: number; maxCharacters: number }
  /**
   * Every part fits, and the parts together do not, on a network that
   * makes one post of a thread. `part` is the first part that no longer
   * fits, and `characters` the length of the whole post.
   */
  | { code: "too_long_together"; characters: number; maxCharacters: number }
  /**
   * The text is within the characters that the network allows and takes
   * more bytes than it allows: on a network that limits both.
   */
  | { code: "too_many_bytes"; bytes: number; maxBytes: number }
  /**
   * The parts together are longer than pigy publishes to one account,
   * `maxContentLength`, whatever the network would take.
   */
  | { code: "too_much_text"; length: number; maxLength: number }
  /** More images than the network takes in one post. */
  | { code: "too_many_images"; images: number; maxImages: number }
  /** The description of the image `image` of the part, from 0, is too long. */
  | {
      code: "alt_too_long";
      image: number;
      characters: number;
      maxCharacters: number;
    }
  /** The post has images, and pigy publishes none to this network yet. */
  | { code: "images_not_published" }
  /** The image `image` of the part is of a shape that the network refuses. */
  | { code: "image_shape"; image: number }
  /**
   * The image `image` of the part cannot be published as things are: see
   * `missing` of an image of a content.
   */
  | {
      code: "image_missing";
      image: number;
      missing: "uploading" | "failed" | "gone";
    }
);

const missingMessages = {
  uploading: "is still being uploaded",
  failed: "was not uploaded. Remove it, or attach it again",
  gone: "is no longer kept: pigy lets go of an image some time after its post was sent",
} as const;

/**
 * What is wrong with `content` for an account with `limits`: nothing, if
 * the list is empty. It asks nobody and changes nothing, so it runs as well
 * in the browser while somebody types as on the server before a post is
 * sent.
 */
export function validateContent(
  limits: Limits,
  content: PostContent,
): ContentIssue[] {
  const issues: ContentIssue[] = [];
  // Whether a part is over the limit by itself, which is said of the part.
  let fits = true;
  const media = mediaLimitsOf(limits);
  const network = networkNames[limits.network];
  // LinkedIn makes one post of a thread, with the images of every part.
  const together = limits.network === "linkedin";
  const images = content.parts.reduce(
    (count, part) => count + (part.media?.length ?? 0),
    0,
  );
  if (images > 0 && imagesNotPublishedTo.includes(limits.network)) {
    issues.push({
      part: null,
      code: "images_not_published",
      message: `pigy does not publish images to ${network} yet. Leave this account out, or give it a text of its own without the images.`,
    });
  }
  if (together && images > media.maxImages) {
    issues.push({
      part: null,
      code: "too_many_images",
      images,
      maxImages: media.maxImages,
      message: `The parts have ${images} images together. ${network} takes them as one post, with ${media.maxImages} images at most.`,
    });
  }
  content.parts.forEach(({ text, media: attached = [] }, part) => {
    const subject =
      content.parts.length === 1 ? "The post" : `Part ${part + 1}`;
    if (!together && attached.length > media.maxImages) {
      issues.push({
        part,
        code: "too_many_images",
        images: attached.length,
        maxImages: media.maxImages,
        message: `${subject} has ${attached.length} images. ${network} takes ${media.maxImages} at most.`,
      });
    }
    attached.forEach((image, index) => {
      const which =
        attached.length === 1
          ? `The image of ${subject === "The post" ? "the post" : subject.toLowerCase()}`
          : `Image ${index + 1} of ${subject === "The post" ? "the post" : subject.toLowerCase()}`;
      if (image.missing) {
        issues.push({
          part,
          code: "image_missing",
          image: index,
          missing: image.missing,
          message: `${which} ${missingMessages[image.missing]}.`,
        });
        return;
      }
      const characters = countAltCharacters(image.alt);
      if (characters > media.maxAltLength) {
        issues.push({
          part,
          code: "alt_too_long",
          image: index,
          characters,
          maxCharacters: media.maxAltLength,
          message: `${which} has a description of ${characters} characters. ${network} takes ${media.maxAltLength}.`,
        });
      }
      const ratio =
        Math.max(image.width, image.height) /
        Math.min(image.width, image.height);
      if (media.maxAspectRatio !== null && ratio > media.maxAspectRatio) {
        issues.push({
          part,
          code: "image_shape",
          image: index,
          message: `${which} is too long for its width, or too wide for its height: ${network} takes ${media.maxAspectRatio} to 1 at most.`,
        });
      }
    });
    if (text.trim() === "") {
      // A part with an image needs no text, on any of the networks.
      if (attached.length === 0) {
        issues.push({
          part,
          code: "empty",
          message: `${subject} has no text.`,
        });
      }
      return;
    }
    const characters = countCharacters(limits, text);
    const { maxCharacters } = limits;
    if (characters > maxCharacters) {
      fits = false;
      issues.push({
        part,
        code: "too_long",
        characters,
        maxCharacters,
        message: `${subject} is ${characters} characters long. The limit is ${maxCharacters}.`,
      });
      return;
    }
    // Asked only where the characters fit. A text that is too long is
    // told so, and shortening it is what cures both.
    if (!("maxBytes" in limits)) return;
    const bytes = utf8Length(text);
    const { maxBytes } = limits;
    if (bytes > maxBytes) {
      issues.push({
        part,
        code: "too_many_bytes",
        bytes,
        maxBytes,
        message: `${subject} takes ${bytes} bytes, which is more than the ${maxBytes} that ${networkNames[limits.network]} allows. Emoji and letters with accents take several each.`,
      });
    }
  });
  // LinkedIn has no threads of an author's own: the parts are one post
  // there, and the limit is that of the post. Said only where each part
  // fits by itself: a part that does not is the one to shorten first.
  if (limits.network === "linkedin" && content.parts.length > 1 && fits) {
    const { maxCharacters } = limits;
    const characters = countCharacters(limits, joinLinkedInParts(content));
    if (characters > maxCharacters) {
      // The first part with which the post is over the limit.
      const part = content.parts.findIndex(
        (_, index) =>
          countCharacters(
            limits,
            joinLinkedInParts({ parts: content.parts.slice(0, index + 1) }),
          ) > maxCharacters,
      );
      issues.push({
        part,
        code: "too_long_together",
        characters,
        maxCharacters,
        message: `The parts are ${characters} characters long together. ${networkNames.linkedin} takes them as one post, with an empty line between them, and its limit is ${maxCharacters}.`,
      });
    }
  }
  const length = content.parts.reduce((sum, { text }) => sum + text.length, 0);
  if (length > maxContentLength) {
    issues.push({
      part: null,
      code: "too_much_text",
      length,
      maxLength: maxContentLength,
      message: `The text is ${length} characters long, all its parts together. pigy publishes at most ${maxContentLength} to one account.`,
    });
  }
  return issues;
}
