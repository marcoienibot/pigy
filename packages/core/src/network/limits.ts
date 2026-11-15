import { z } from "zod";
import type { PostContent } from "./content.ts";
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

export const limitsSchema = z.discriminatedUnion("network", [
  mastodonLimitsSchema,
]);

export type Limits = z.infer<typeof limitsSchema>;

/** The length of `text` as the network of `limits` counts it. */
export function countCharacters(limits: Limits, text: string): number {
  switch (limits.network) {
    case "mastodon":
      return countMastodonCharacters(text, limits.charactersPerUrl);
  }
}

/** Something that keeps content from being published to a network. */
export type ContentIssue = {
  /** Which part it is about, counted from 0. */
  part: number;
  /** For people. */
  message: string;
} & (
  | { code: "empty" }
  | { code: "too_long"; characters: number; maxCharacters: number }
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
      issues.push({
        part,
        code: "too_long",
        characters,
        maxCharacters,
        message: `${subject} is ${characters} characters long. The limit is ${maxCharacters}.`,
      });
    }
  });
  return issues;
}
