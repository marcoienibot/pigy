import type { PostContent } from "./content.ts";

/**
 * How LinkedIn measures the text of a post, and how pigy makes one post of
 * a thread there: LinkedIn has no threads of an author's own, so the parts
 * are joined.
 *
 * The limit is that of the `commentary` of a post in LinkedIn's Posts API,
 * 3000 characters. LinkedIn does not document what a character is.
 * GUESS: a UTF-16 code unit, which is what the length of a string is on
 * LinkedIn's platform and in its own editor: an emoji outside the basic
 * plane counts as two. A link and a mention count as they are written.
 * PLAN.md section 19 lists it for the first live run.
 */

/** The most characters in the text of a post. */
export const linkedInMaxCharacters = 3000;

/** The length of `text` as LinkedIn counts it against its limit. */
export function countLinkedInCharacters(text: string): number {
  return text.length;
}

/** What stands between two parts of a thread in the one post: an empty line. */
export const linkedInPartSeparator = "\n\n";

/**
 * The text of the one post that `content` is on LinkedIn: its parts in
 * order, each as it is written, with an empty line between them.
 */
export function joinLinkedInParts(content: PostContent): string {
  return content.parts.map(({ text }) => text).join(linkedInPartSeparator);
}
