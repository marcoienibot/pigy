/**
 * The text of a post as LinkedIn takes it: in its "little text format",
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/little-text-format.
 * The format marks mentions and hashtags with characters that it reserves,
 * and a text that means one of those characters has to write it after a
 * backslash.
 */

// The characters that the format reserves.
const reserved = new Set("|{}@[]()<>#\\*_~");

/**
 * The text that `commentary` shows as, or what is wrong with it.
 *
 * Only plain text is simulated: no mention, `@[Name](urn:li:person:…)`,
 * and no hashtag template, `{hashtag|\#|tag}`. A reserved character that
 * is not escaped would begin one of them, or would be taken by LinkedIn in
 * a way that it does not document: it is known to cut a post short at one.
 * So this refuses it, where LinkedIn would publish something else than was
 * meant.
 */
export function readLittleText(
  commentary: string,
): { text: string } | { error: string } {
  let text = "";
  const characters = Array.from(commentary);
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index] ?? "";
    if (character === "\\") {
      const next = characters[index + 1];
      if (next === undefined || !reserved.has(next)) {
        return {
          error:
            "The simulated LinkedIn takes a backslash only before a reserved character of the little text format.",
        };
      }
      text += next;
      index++;
    } else if (reserved.has(character)) {
      return {
        error: `The simulated LinkedIn takes plain text only: the reserved character "${character}" has to be escaped with a backslash. Mentions and hashtag templates are not simulated.`,
      };
    } else {
      text += character;
    }
  }
  return { text };
}
