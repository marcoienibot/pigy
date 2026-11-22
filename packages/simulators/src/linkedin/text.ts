import type { SimEntity } from "../world/world.ts";

/**
 * The text of a post as LinkedIn takes it: in its "little text format",
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/little-text-format.
 * The format marks mentions and hashtags with characters that it reserves,
 * and a text that means one of those characters has to write it after a
 * backslash.
 */

// The characters that the format reserves.
const reserved = new Set("|{}@[]()<>#\\*_~");

// How a hashtag template begins: the word, and the sign, which is
// escaped like every reserved character. The format also has the
// full-width sign.
const templateStarts = ["{hashtag|\\#|", "{hashtag|\\＃|"];

/**
 * The text that `commentary` shows as, with where its hashtags stand in
 * it, or what is wrong with it.
 *
 * Simulated: plain text, and the hashtag template, `{hashtag|\#|tag}`,
 * which shows as "#tag". GUESS: the name of the tag is text of the format
 * like any other, so a reserved character in it is escaped, and it is
 * not empty.
 *
 * Not simulated, and refused: a mention, `@[Name](urn:li:person:…)`, and
 * a hashtag that is written as "#tag" without the template. A reserved
 * character that is not escaped would begin one of them, or would be
 * taken by LinkedIn in a way that it does not document: it is known to
 * cut a post short at one. So this refuses it, where LinkedIn would
 * publish something else than was meant.
 */
export function readLittleText(
  commentary: string,
): { text: string; hashtags: SimEntity[] } | { error: string } {
  let text = "";
  const hashtags: SimEntity[] = [];
  /** The tag whose template is open, by where it began in the text. */
  let open: { start: number } | null = null;
  const characters = Array.from(commentary);
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index] ?? "";
    const rest = () => characters.slice(index).join("");
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
    } else if (open === null && character === "{") {
      const start = templateStarts.find((begin) => rest().startsWith(begin));
      if (start === undefined) {
        return {
          error:
            'The simulated LinkedIn takes "{" only where it begins a hashtag template, {hashtag|\\#|tag}. Elsewhere it has to be escaped with a backslash.',
        };
      }
      open = { start: text.length };
      text += "#";
      index += Array.from(start).length - 1;
    } else if (open !== null && character === "}") {
      const tag = text.slice(open.start + 1);
      if (tag === "") {
        return {
          error: "A hashtag template of the little text format needs a tag.",
        };
      }
      hashtags.push({
        kind: "hashtag",
        start: open.start,
        end: text.length,
        target: tag,
      });
      open = null;
    } else if (reserved.has(character)) {
      return {
        error: `The simulated LinkedIn takes the reserved character "${character}" only after a backslash. Mentions are not simulated, and a hashtag is taken as a template.`,
      };
    } else if (open !== null && /\s/.test(character)) {
      return {
        error: "A hashtag of the little text format has no whitespace in it.",
      };
    } else {
      text += character;
    }
  }
  if (open !== null) {
    return {
      error: "A hashtag template of the little text format is not closed.",
    };
  }
  return { text, hashtags };
}
