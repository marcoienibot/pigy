import { z } from "zod";
import { countBlueskyCharacters, utf8Length } from "./bluesky.ts";
import type { PostContent } from "./content.ts";
import { countLinkedInCharacters, joinLinkedInParts } from "./linkedin.ts";
import { countMastodonCharacters } from "./mastodon.ts";

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
 * The limits of an account on Mastodon. They are those of its instance and
 * are read from it, never assumed: instances choose their own.
 */
export const mastodonLimitsSchema = z.strictObject({
  network: z.literal("mastodon"),
  /** The most characters in one post, counted the way Mastodon counts. */
  maxCharacters: z.number().int().positive(),
  /** What every link counts as, however long it is. */
  charactersPerUrl: z.number().int().nonnegative(),
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
});

export const limitsSchema = z.discriminatedUnion("network", [
  blueskyLimitsSchema,
  linkedInLimitsSchema,
  mastodonLimitsSchema,
]);

export type Limits = z.infer<typeof limitsSchema>;

/** The length of `text` as the network of `limits` counts it. */
export function countCharacters(limits: Limits, text: string): number {
  switch (limits.network) {
    case "bluesky":
      return countBlueskyCharacters(text);
    case "linkedin":
      return countLinkedInCharacters(text);
    case "mastodon":
      return countMastodonCharacters(text, limits.charactersPerUrl);
  }
}

// What a message calls a network.
const networkNames: { readonly [Name in Limits["network"]]: string } = {
  bluesky: "Bluesky",
  linkedin: "LinkedIn",
  mastodon: "Mastodon",
};

/** Something that keeps content from being published to a network. */
export type ContentIssue = {
  /** Which part it is about, counted from 0. */
  part: number;
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
);

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
  content.parts.forEach(({ text }, part) => {
    const subject =
      content.parts.length === 1 ? "The post" : `Part ${part + 1}`;
    if (text.trim() === "") {
      issues.push({ part, code: "empty", message: `${subject} has no text.` });
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
  return issues;
}
