import type { PostContent } from "./content.ts";
import { joinLinkedInParts, linkedInPartSeparator } from "./linkedin.ts";
import { findLinks, type TextRange } from "./links.ts";
import { findMastodonMentions } from "./mastodon.ts";
import type { Network } from "./network.ts";

/**
 * What is in a text besides its words: links, mentions and hashtags, each
 * with where it stands. Pure functions, so that the editor marks while
 * somebody types what the adapter marks up when the post goes out, and
 * what a counter counts.
 *
 * The rules, decided in phase 4b:
 *
 * - **Links** are found by `findLinks` of links.ts, for every network the
 *   same way. Mastodon links only an address with its scheme, so one
 *   without is plain text there.
 * - **Hashtags** are found the same way for every network: "#" or "＃" and
 *   then letters, marks, digits and underscores of any script, with a
 *   letter among them, so "#1" is none. It does not begin in the middle of
 *   a word or of an address. A tag is 64 characters at most, which is what
 *   Bluesky takes: a longer one is plain text. Threads takes one tag per
 *   post, so only the first hashtag of a text is one there.
 * - **Mentions** are written the way the network addresses an account:
 *   "@name" and "@name@example.com" on Mastodon, "@handle.example.com" on
 *   Bluesky, where a handle is a domain name, and "@username" on Threads.
 *   LinkedIn has none that pigy could write: a mention there names a
 *   member by an ID that LinkedIn gives pigy no way to look up.
 * - Nothing overlaps: what stands within a link is part of the link, so
 *   "https://example.com/@ada#top" is a link and nothing else.
 *
 * Mastodon and Threads find these themselves in what they are sent, and
 * what they find is theirs to decide: for them this says what pigy
 * expects, and the tests of their simulators, which find them in code of
 * their own, hold the two together. For Bluesky and LinkedIn it is what
 * the adapter marks up, so it is what is there.
 */

/** Something in a text that a network shows as more than text. */
export type TextEntity = TextRange &
  (
    | {
        kind: "link";
        /** The address that it leads to, with its scheme. */
        url: string;
      }
    | {
        kind: "mention";
        /**
         * Who is mentioned, as the network addresses them, without the
         * "@": "ada", "ada@example.com", "ada.example.com".
         */
        name: string;
      }
    | {
        kind: "hashtag";
        /** The tag, without the "#". */
        tag: string;
      }
  );

/** The longest tag, in characters: `maxGraphemes` of a tag of Bluesky. */
export const maxHashtagLength = 64;

const wordChar = String.raw`\p{L}\p{M}\p{Nd}\p{Pc}`;

const hashtagPattern = new RegExp(
  // Not in the middle of a word, an address or a parameter.
  String.raw`(^|[^${wordChar}&\/=)])` + String.raw`[#＃]([\p{L}\p{M}\p{Nd}_]+)`,
  "gu",
);

// A handle of atproto: a domain name of two or more labels, whose last
// does not begin with a digit. "Handle" of the specifications.
const handleLabel = "[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?";
const blueskyMentionPattern = new RegExp(
  String.raw`(^|[\p{White_Space}(])` +
    `@((?:${handleLabel}\\.)+[a-zA-Z](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)`,
  "gu",
);

/**
 * A mention on Threads. GUESS: Meta does not document what it takes for
 * one. A username of Threads is that of Instagram: letters of ASCII,
 * digits, underscores and full stops, 30 at most, and it does not end in
 * a full stop here, so that the one after a sentence is not part of it.
 */
const threadsMentionPattern = new RegExp(
  String.raw`(^|[^${wordChar}@\/.])` +
    "@([a-zA-Z0-9_](?:[a-zA-Z0-9_.]{0,28}[a-zA-Z0-9_])?)",
  "gu",
);

let graphemes: Intl.Segmenter | undefined;

function hashtagsOf(text: string): TextEntity[] {
  graphemes ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const tags: TextEntity[] = [];
  for (const match of text.matchAll(hashtagPattern)) {
    const [whole, before = "", tag = ""] = match;
    if (!/\p{L}/u.test(tag)) continue;
    if ([...graphemes.segment(tag)].length > maxHashtagLength) continue;
    tags.push({
      kind: "hashtag",
      start: match.index + before.length,
      end: match.index + whole.length,
      tag,
    });
  }
  return tags;
}

function mentionsBy(pattern: RegExp, text: string): TextEntity[] {
  return [...text.matchAll(pattern)].map((match) => {
    const [whole, before = "", name = ""] = match;
    return {
      kind: "mention",
      start: match.index + before.length,
      end: match.index + whole.length,
      name,
    };
  });
}

function mentionsOf(network: Network | null, text: string): TextEntity[] {
  switch (network) {
    case "bluesky":
      return mentionsBy(blueskyMentionPattern, text).map((mention) => ({
        ...mention,
        // A handle is compared in lower case.
        ...(mention.kind === "mention" && {
          name: mention.name.toLowerCase(),
        }),
      }));
    case "threads":
      return mentionsBy(threadsMentionPattern, text);
    case "linkedin":
      return [];
    // With no network to go by, what any of them would take: the form of
    // Mastodon covers the other two.
    case "mastodon":
    case null:
      return findMastodonMentions(text).map(
        ({ start, end, username, domain }) => ({
          kind: "mention",
          start,
          end,
          name: domain === undefined ? username : `${username}@${domain}`,
        }),
      );
  }
}

/**
 * The links, mentions and hashtags of `text` as `network` understands
 * them, in their order, none within another. With null for the network,
 * what any network would understand: for a text that goes nowhere yet.
 */
export function detectEntities(
  network: Network | null,
  text: string,
): TextEntity[] {
  const links: TextEntity[] = findLinks(text, {
    bare: network !== "mastodon",
  }).map((link) => ({ kind: "link", ...link }));
  let hashtags = hashtagsOf(text);
  const found: TextEntity[] = [...links];
  const free = (entity: TextEntity) =>
    !found.some(
      (other) => entity.start < other.end && other.start < entity.end,
    );
  // A mention before a hashtag, for a text such as "@ada#tag" to be read
  // one way. Neither is taken out of a link.
  for (const mention of mentionsOf(network, text)) {
    if (free(mention)) found.push(mention);
  }
  hashtags = hashtags.filter(free);
  // Threads has one tag per post: the first.
  found.push(...(network === "threads" ? hashtags.slice(0, 1) : hashtags));
  return found.sort((a, b) => a.start - b.start);
}

const encoder = new TextEncoder();

/**
 * Where `range` of `text` stands in the bytes of its UTF-8, which is how
 * Bluesky addresses a stretch of a text: an emoji is four bytes there and
 * two code units here.
 */
export function utf8Range(
  text: string,
  { start, end }: TextRange,
): { byteStart: number; byteEnd: number } {
  const byteStart = encoder.encode(text.slice(0, start)).length;
  return {
    byteStart,
    byteEnd: byteStart + encoder.encode(text.slice(start, end)).length,
  };
}

/**
 * Who makes the card of a link on each network: pigy, which then has to
 * read the page and send what it found with the post, or the network,
 * which reads the page itself once it has the post.
 */
export const cardMaker: { readonly [Name in Network]: "pigy" | "network" } = {
  bluesky: "pigy",
  linkedin: "pigy",
  mastodon: "network",
  threads: "network",
};

/**
 * The link whose card each part of `content` is shown with on `network`,
 * or null for a part that has none: the first link of the part. On
 * LinkedIn, where the parts are one post, that post has one card, of its
 * first link, and it is listed with the part that the link is in.
 */
export function cardLinks(
  network: Network,
  content: PostContent,
): (string | null)[] {
  const first = (text: string) =>
    detectEntities(network, text).find((entity) => entity.kind === "link");
  if (network !== "linkedin") {
    return content.parts.map(({ text }) => {
      const link = first(text);
      return link?.kind === "link" ? link.url : null;
    });
  }
  const link = first(joinLinkedInParts(content));
  let offset = 0;
  return content.parts.map(({ text }) => {
    const begins = offset;
    offset += text.length + linkedInPartSeparator.length;
    return link?.kind === "link" &&
      link.start >= begins &&
      link.start < begins + text.length
      ? link.url
      : null;
  });
}
