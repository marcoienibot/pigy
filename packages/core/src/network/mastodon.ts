/**
 * How Mastodon counts the characters of a post, after
 * https://docs.joinmastodon.org/user/posting/ and the validator it runs,
 * app/validators/status_length_validator.rb: every link counts as a fixed
 * number of characters, a mention counts without its domain, and what is
 * left is counted in grapheme clusters, so an emoji made of several code
 * points is one character. What a mention is comes from the code that the
 * validator calls, app/lib/extractor.rb.
 *
 * What counts as a link follows the pattern Mastodon 4.5 uses, with one
 * difference: Mastodon accepts only the top-level domains that exist, and
 * this accepts any of two or more ASCII letters. So "https://example.nosuch"
 * counts as a link here and as plain text there. Mastodon's development
 * branch has since changed how it finds links, so the edge cases of this
 * pattern are worth confirming against a real server.
 */

// The pieces of a link, as in config/initializers/twitter_regex.rb.
const pathChar = String.raw`[^\p{White_Space}<>()?]`;
// Parentheses belong to a link only in pairs, one level deep.
const balanced = String.raw`\((?:${pathChar}+|${pathChar}*\(${pathChar}+\)${pathChar}*)\)`;
// A link does not end in punctuation: the full stop after it is not part
// of it.
const pathEnd = String.raw`(?:[^\p{White_Space}()?!*"'「」<>;:=,.$%\[\]~&|]|${balanced})`;
const path = String.raw`(?:${pathChar}*(?:${balanced}${pathChar}*)*${pathEnd}|${pathChar}+\/)`;
const beyondAscii = String.raw`\u{A0}-\u{D7FF}\u{E000}-\u{FDCF}\u{FDF0}-\u{FFEF}\u{10000}-\u{10FFFD}`;
const queryChar = String.raw`[a-z0-9!?*'();:&=+$\/%#\[\]\-_.,~|@^${beyondAscii}]`;
const queryEnd = String.raw`[a-z0-9_&=#\/\-${beyondAscii}]`;
// Anything but whitespace, control characters and ASCII punctuation.
const hostChar = String.raw`[^\p{White_Space}\p{Cc}!-\/:-@\[-\x60{-~]`;
const hostLabel = String.raw`(?:${hostChar}(?:[_-]|${hostChar})*)?${hostChar}\.`;
const topLevelDomain = "(?:[a-z]{2,}(?![0-9a-z@+-])|xn--[0-9a-z]+)";

// These patterns do without lookbehind, which older browsers that pigy
// still opens in cannot compile: what must stand before a match is matched
// with it, as the first group, and put back.

const linkPattern = new RegExp(
  // Not in the middle of a word, a mention or a hashtag.
  "(^|[^a-z0-9@＠$#＃])" +
    String.raw`https?:\/\/` +
    `(?:${hostLabel})+${topLevelDomain}` +
    "(?::[0-9]+)?" +
    String.raw`(?:\/${path}*)?` +
    String.raw`(?:\?${queryChar}*${queryEnd})?`,
  "giu",
);

// What Ruby calls a word character.
const wordChar = String.raw`[\p{L}\p{M}\p{Nd}\p{Pc}]`;

// The two halves of a mention, as in Account::MENTION_RE: the name, which
// does not begin in the middle of a word, a path or a parameter, and the
// domain.
const mentionName = String.raw`(^|[^=\/\p{L}\p{M}\p{Nd}\p{Pc}])@([a-z0-9_]+(?:[.-]+[a-z0-9_]+)*)`;
const mentionDomain = `@(${wordChar}+(?:[.-]+${wordChar}+)*)`;

// A mention with a domain: "@name@example.com".
const remoteMentionPattern = new RegExp(mentionName + mentionDomain, "giu");

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
 * "@ADA@mastodon.example" becomes "@ada", "@gargron@mastodon.social" becomes
 * "@Gargron@mastodon.social", and a domain that stands for another becomes
 * that one.
 *
 * Which accounts a server finds, only the server knows. So this does not
 * rewrite as Mastodon does. It reduces every mention to what both spellings
 * share, the name in lower case. It takes for a mention what Mastodon
 * rewrites, which is more than what `countMastodonCharacters` counts as
 * one. Two texts with the same form therefore differ at most in the case
 * and the domains of their mentions.
 *
 * Not covered: an account whose server answers for it under another name,
 * which Mastodon then writes, and "@a@b.example@c", which Mastodon may save
 * as the mention "@a@c".
 */
export function comparableMastodonText(text: string): string {
  return stripMastodonText(text).replace(
    mentionPattern,
    (_mention: string, before: string, username: string) =>
      `${before}@${username.toLowerCase()}`,
  );
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
  const placeholder = "x".repeat(charactersPerUrl);
  const countable = stripped
    .replace(
      linkPattern,
      (_link: string, before: string) => before + placeholder,
    )
    .replace(
      remoteMentionPattern,
      (
        mention: string,
        before: string,
        username: string,
        domain: string,
        offset: number,
        whole: string,
      ) =>
        // Ruby counts the length of a text in code points.
        Array.from(domain).length > maxMentionDomainLength ||
        afterMentionPattern.test(whole.slice(offset + mention.length))
          ? mention
          : `${before}@${username}`,
    );
  graphemes ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let count = 0;
  for (const _ of graphemes.segment(countable)) count++;
  return count;
}
