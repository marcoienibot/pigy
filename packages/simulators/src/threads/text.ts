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

import { findLinks } from "../mastodon/text.ts";
import { type WebPage, webPageAt } from "../web/index.ts";
import type { SimCard, SimEntity } from "../world/world.ts";

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

/**
 * What Threads makes of the text of a post, after "Posts" of the
 * documentation: "the first URL included in the text field will be used
 * as the link preview" where a post names no `link_attachment`, and a
 * post has one topic tag, "the first valid tag included in a post".
 *
 * GUESS, all of the detail, which Meta does not document:
 *
 * - What a link is. Here it is what the simulated Mastodon takes for one:
 *   an address with its scheme.
 * - What a tag is: "#" and then letters, digits and underscores with a
 *   letter among them, not in the middle of a word or an address. Only
 *   the first is a tag, and a later one stays text.
 * - What a mention is: "@" and the username of an account that there is,
 *   in any case, not in the middle of a word or an address.
 *
 * `userOf` is given a username in lower case and returns the ID of the
 * account, or undefined for nobody: such a mention stays text.
 */
export function findEntities(
  text: string,
  userOf: (username: string) => string | undefined,
): { entities: SimEntity[]; card: SimCard | null; topicTag: string | null } {
  const links: SimEntity[] = findLinks(text).map(({ start, end }) => ({
    kind: "link",
    start,
    end,
    target: text.slice(start, end),
  }));
  const free = (start: number, end: number) =>
    !links.some((link) => start < link.end && link.start < end);
  const entities = [...links];
  for (const match of text.matchAll(
    /(?<![\p{L}\p{N}_@/.])@([A-Za-z0-9_.]+)/gu,
  )) {
    // A full stop at the end is that of the sentence.
    const username = (match[1] ?? "").replace(/\.+$/, "");
    const id = userOf(username.toLowerCase());
    const end = match.index + 1 + username.length;
    if (id !== undefined && free(match.index, end)) {
      entities.push({ kind: "mention", start: match.index, end, target: id });
    }
  }
  let topicTag: string | null = null;
  for (const match of text.matchAll(
    /(?<![\p{L}\p{N}_&/=])[#＃]([\p{L}\p{M}\p{N}_]+)/gu,
  )) {
    const tag = match[1] ?? "";
    const end = match.index + match[0].length;
    if (!/\p{L}/u.test(tag) || !free(match.index, end)) continue;
    topicTag = tag;
    entities.push({ kind: "hashtag", start: match.index, end, target: tag });
    break;
  }
  const [first] = links;
  // The web of a simulated world is the simulated web.
  const page: WebPage | undefined = first && webPageAt(first.target);
  return {
    entities: entities.sort((a, b) => a.start - b.start),
    card: page
      ? {
          url: page.url,
          title: page.ogTitle ?? page.title ?? "",
          description: page.ogDescription ?? page.description ?? "",
        }
      : null,
    topicTag,
  };
}
