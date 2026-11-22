import { detectEntities } from "@pigy/core";

/**
 * The text of a post as LinkedIn wants it written: in its "little text
 * format", which marks mentions and hashtags with characters that it
 * reserves. A text that means one of those characters writes it after a
 * backslash. Left as they are, LinkedIn takes them for the beginning of
 * something else, and has been seen to cut a post short at one.
 */
export function escapeLittleText(text: string): string {
  return text.replace(/[|{}@[\]()<>#\\*_~]/g, "\\$&");
}

/**
 * `text` in the little text format, as pigy posts it:
 *
 * - **A hashtag** is written as the template of the format,
 *   `{hashtag|\#|tag}`, which says where the tag ends: what a hashtag is,
 *   `detectEntities` of `@pigy/core` decides, as for every network. GUESS:
 *   the name of the tag is text of the format like any other, so a
 *   reserved character in it, which can only be an underscore, is
 *   escaped. PLAN.md section 19 has it for the first live run.
 * - **A mention** is not written. The format has one, `@[Name](urn)`,
 *   which names a member by an ID that LinkedIn gives pigy no way to look
 *   up for a name. So "@ada" is escaped, and is the text that it is.
 * - **A link** needs nothing: LinkedIn finds the addresses in a text
 *   itself. Its preview is not in the text: see `articleOf` in index.ts.
 * - **Everything else** is text, with every reserved character escaped.
 */
export function littleText(text: string): string {
  let written = "";
  let position = 0;
  for (const entity of detectEntities("linkedin", text)) {
    if (entity.kind !== "hashtag") continue;
    written += escapeLittleText(text.slice(position, entity.start));
    // The sign as it was written: the format has the full-width one too.
    const sign = text.slice(entity.start, entity.start + 1);
    written += `{hashtag|\\${sign}|${escapeLittleText(entity.tag)}}`;
    position = entity.end;
  }
  return written + escapeLittleText(text.slice(position));
}
