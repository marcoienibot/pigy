/**
 * How Threads measures the text of a post, after the reference of Meta's
 * Threads API for the parameter `text`: at most 500 characters, and "emojis
 * are counted as the number of UTF-8 bytes that they take, not as one
 * character".
 *
 * GUESS: what a character is, and what an emoji. Here a character is a
 * code point, and an emoji is every code point that a pictograph is made
 * of: the pictograph itself, a modifier of its skin tone, a regional
 * indicator of a flag, and what joins and marks them, the zero width
 * joiner, the variation selector 16, the enclosing keycap and the tags of
 * a flag. Each of those counts as its bytes in UTF-8. Where this is wrong
 * it counts too much rather than too little: a joiner between letters of a
 * script that uses one counts as three. A link and a mention count as
 * they are written. PLAN.md section 19 lists it for the first live run.
 */

/** The most characters in the text of a post. */
export const threadsMaxCharacters = 500;

// A code point that an emoji is made of.
const emojiPart =
  /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}‍️⃣\u{E0020}-\u{E007F}]/u;

/** How many bytes a code point takes in UTF-8. */
function utf8Bytes(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  return codePoint < 0x10000 ? 3 : 4;
}

/** The length of `text` as Threads counts it against its limit. */
export function countThreadsCharacters(text: string): number {
  let count = 0;
  for (const character of text) {
    count += emojiPart.test(character)
      ? utf8Bytes(character.codePointAt(0) ?? 0)
      : 1;
  }
  return count;
}
