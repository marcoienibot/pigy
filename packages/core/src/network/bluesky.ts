/**
 * How Bluesky measures the text of a post, after the schema of a post,
 * the lexicon `app.bsky.feed.post`: at most 300 grapheme clusters, so an
 * emoji made of several code points is one character, and at most 3000
 * bytes in UTF-8. Both hold at once. A text of 300 emoji that are each
 * made of many code points is short enough by the first and too large by
 * the second.
 *
 * The text counts as it is written: Bluesky does not shorten a link or a
 * mention when it counts, and it drops no whitespace.
 */

/** The most grapheme clusters in a post: `maxGraphemes` of the lexicon. */
export const blueskyMaxCharacters = 300;

/** The most bytes of UTF-8 in a post: `maxLength` of the lexicon. */
export const blueskyMaxBytes = 3000;

// Made when it is first needed, so that a browser without it can still load
// the rest of this package.
let graphemes: Intl.Segmenter | undefined;

/** The length of `text` as Bluesky counts it against its limit. */
export function countBlueskyCharacters(text: string): number {
  graphemes ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let count = 0;
  for (const _ of graphemes.segment(text)) count++;
  return count;
}

/** How many bytes `text` takes in UTF-8. */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}
