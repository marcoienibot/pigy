/**
 * How Mastodon counts the characters of a post, after
 * https://docs.joinmastodon.org/user/posting/ and the validator it runs,
 * app/validators/status_length_validator.rb: every link counts as a fixed
 * number of characters, a mention counts without its domain, and what is
 * left is counted in grapheme clusters, so an emoji made of several code
 * points is one character. What a mention is comes from the code that the
 * validator calls, app/lib/extractor.rb.
 *
 * What counts as a link is what `findLinks` of links.ts finds with a
 * scheme, which follows the pattern Mastodon 4.5 uses: Mastodon links no
 * address that is written without one. Mastodon's development branch has
 * since changed how it finds links, so the edge cases of that pattern are
 * worth confirming against a real server.
 *
 * The counting and the detection of `entities.ts` go by the same two
 * functions, `findLinks` and `findMastodonMentions`: what the editor marks
 * as a link is what the counter counts as one.
 */

import { findLinks, type TextRange } from "./links.ts";

// These patterns do without lookbehind, which older browsers that pigy
// still opens in cannot compile: what must stand before a match is matched
// with it, as the first group, and put back.

// What Ruby calls a word character.
const wordChar = String.raw`[\p{L}\p{M}\p{Nd}\p{Pc}]`;

// The two halves of a mention, as in Account::MENTION_RE: the name, which
// does not begin in the middle of a word, a path or a parameter, and the
// domain.
const mentionName = String.raw`(^|[^=\/\p{L}\p{M}\p{Nd}\p{Pc}])@([a-z0-9_]+(?:[.-]+[a-z0-9_]+)*)`;
const mentionDomain = `@(${wordChar}+(?:[.-]+${wordChar}+)*)`;

// Every mention, with a domain or without: "@name" too.
const mentionPattern = new RegExp(`${mentionName}(?:${mentionDomain})?`, "giu");

// The longest domain that Mastodon takes in a mention, in characters. With
// a longer one the text is no mention, and counts in full.
const maxMentionDomainLength = 253;

// What must not follow a mention: Mastodon then takes it for something else,
// such as "@name@example.com@more" or an address with accented letters.
const afterMentionPattern =
  /^(?:[@＠]|[\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u00FF\u0100-\u024F\u0253-\u0254\u0256-\u0257\u0259\u025B\u0263\u0268\u026F\u0272\u0289\u028B\u02BB\u1E00-\u1EFF]|[\u0300-\u036F]|:\/\/)/u;

// Made when it is first needed, so that a browser without it can still load
// the rest of this package.
let graphemes: Intl.Segmenter | undefined;

/**
 * The text as Mastodon stores it: without the whitespace around it. This is
 * what Ruby's `strip` removes, which is less than `trim` does.
 */
export function stripMastodonText(text: string): string {
  return text.replace(/^[\0\t\n\v\f\r ]+|[\0\t\n\v\f\r ]+$/g, "");
}

/**
 * `text` in a form that is the same before and after Mastodon saves it, to
 * tell whether a status holds a text that was sent. The source of a status
 * is not that text. Mastodon drops the whitespace around it, and it writes
 * every mention of an account that it finds the way the account is written,
 * app/services/process_mentions_service.rb: on mastodon.example,
 * "@ADA@mastodon.example" becomes "@ada", and "@gargron@mastodon.social"
 * becomes "@Gargron@mastodon.social".
 *
 * Which accounts a server finds, only the server knows. So this does not
 * rewrite as Mastodon does. It writes every mention in lower case, its
 * domain the way Mastodon keeps domains, and without the domain if that is
 * one of `ownDomains`, the domains of the instance itself: those are the
 * things that Mastodon changes in a mention it has found. The domain of
 * another instance stays, because "@ada@one.example" and
 * "@ada@other.example" are two people. It takes for
 * a mention what Mastodon rewrites, which is more than what
 * `countMastodonCharacters` counts as one. Two texts with the same form
 * therefore differ at most in the case of their mentions, and in whether a
 * mention of an account of the instance names the instance.
 *
 * Not covered: a domain that stands for another, which Mastodon replaces
 * by that one, an account whose server answers for it under another name,
 * which Mastodon then writes, and "@a@b.example@c", which Mastodon may save
 * as the mention "@a@c".
 */
export function comparableMastodonText(
  text: string,
  ownDomains: readonly string[],
): string {
  const own = new Set(ownDomains.map(storedDomain));
  return stripMastodonText(text).replace(
    mentionPattern,
    (
      _mention: string,
      before: string,
      username: string,
      domain: string | undefined,
    ) => {
      const name = `${before}@${username.toLowerCase()}`;
      const host = domain === undefined ? undefined : storedDomain(domain);
      return host === undefined || own.has(host) ? name : `${name}@${host}`;
    },
  );
}

/**
 * A domain as Mastodon keeps it, lib/tag_manager.rb: in lower case and in
 * ASCII, so "bücher.example" as "xn--bcher-kva.example". A mention that was
 * written the first way is saved the second.
 */
function storedDomain(domain: string): string {
  try {
    return new URL(`https://${domain}`).hostname;
  } catch {
    // Nothing that a URL can name. Then it is no account's domain either,
    // and Mastodon leaves the mention as it is.
    return domain.toLowerCase();
  }
}

/** A mention in a text, as Mastodon reads one. */
export type MastodonMention = TextRange & {
  /** The name before the domain, as it is written. */
  username: string;
  /** The domain, as it is written, or undefined for "@name". */
  domain: string | undefined;
};

/**
 * The mentions of `text` as Mastodon's extractor finds them,
 * app/lib/extractor.rb: "@name" and "@name@example.com". What only looks
 * like one is left out: a domain that is longer than Mastodon takes, and
 * a mention that is followed by what makes Mastodon take it for something
 * else.
 */
export function findMastodonMentions(text: string): MastodonMention[] {
  const mentions: MastodonMention[] = [];
  for (const match of text.matchAll(mentionPattern)) {
    const [whole, before = "", username = "", domain] = match;
    const start = match.index + before.length;
    const end = match.index + whole.length;
    if (
      // Ruby counts the length of a text in code points.
      (domain !== undefined &&
        Array.from(domain).length > maxMentionDomainLength) ||
      afterMentionPattern.test(text.slice(end))
    ) {
      continue;
    }
    mentions.push({ start, end, username, domain });
  }
  return mentions;
}

/**
 * The length of `text` as a Mastodon server counts it against its limit.
 * `charactersPerUrl` is what the instance counts a link as, 23 unless it
 * says otherwise.
 */
export function countMastodonCharacters(
  text: string,
  charactersPerUrl: number,
): number {
  const stripped = stripMastodonText(text);
  const links = findLinks(stripped, { bare: false });
  // What counts as something else than it is written: a link as a fixed
  // number of characters, a mention without its domain.
  const counted = [
    ...links.map((link) => ({ ...link, as: "x".repeat(charactersPerUrl) })),
    ...findMastodonMentions(stripped)
      .filter(
        (mention) =>
          mention.domain !== undefined &&
          // An address is a link, whatever is in it.
          !links.some(
            (link) => mention.start < link.end && link.start < mention.end,
          ),
      )
      .map((mention) => ({ ...mention, as: `@${mention.username}` })),
  ].sort((a, b) => a.start - b.start);
  let countable = "";
  let position = 0;
  for (const { start, end, as } of counted) {
    countable += stripped.slice(position, start) + as;
    position = end;
  }
  countable += stripped.slice(position);
  graphemes ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let count = 0;
  for (const _ of graphemes.segment(countable)) count++;
  return count;
}
