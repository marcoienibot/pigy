/**
 * How the simulated Threads counts the text of a post against its limit
 * of 500, after the reference of the parameter `text`: characters, with an
 * emoji counted as the bytes that it takes in UTF-8.
 *
 * GUESS: a character is a code point, and an emoji every code point that
 * a pictograph is made of, with what joins and marks them. This is
 * written apart from pigy's own counting, in `packages/core`, and has to
 * agree with it: the conformance suite of the adapter sees to that.
 */

/** The most characters in the text of a post. */
export const maxCharacters = 500;

const encoder = new TextEncoder();

/** Whether a code point is part of an emoji. */
function ofAnEmoji(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return (
    /\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}/u.test(
      character,
    ) ||
    // The zero width joiner, the variation selector 16, the enclosing
    // keycap and the tags that spell the region of a flag.
    code === 0x200d ||
    code === 0xfe0f ||
    code === 0x20e3 ||
    (code >= 0xe0020 && code <= 0xe007f)
  );
}

export function countCharacters(text: string): number {
  return Array.from(text).reduce(
    (count, character) =>
      count + (ofAnEmoji(character) ? encoder.encode(character).length : 1),
    0,
  );
}
