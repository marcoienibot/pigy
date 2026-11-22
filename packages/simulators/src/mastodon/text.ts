import { escapeHtml } from "../world/pages.ts";
import type { SimEntity } from "../world/world.ts";

/**
 * What Mastodon does with the text of a status: how it counts it against
 * the limit, and how it turns it into the HTML it hands out.
 *
 * Written from https://docs.joinmastodon.org/user/posting/ and, where that
 * leaves a question open, from the code it describes:
 * app/validators/status_length_validator.rb, app/lib/extractor.rb, the link
 * pattern in config/initializers/twitter_regex.rb and
 * app/lib/text_formatter.rb, all as of Mastodon 4.5. It shares nothing with
 * the counting in @pigy/core, on purpose: the two are meant to catch each
 * other's mistakes.
 *
 * GUESS, to confirm against a real server: Mastodon takes a link only if
 * its top-level domain exists. This takes any of two or more ASCII letters.
 */

type Range = { start: number; end: number };

const whitespace = /\p{White_Space}/u;
// A host is made of anything but whitespace, control characters and ASCII
// punctuation. Hyphens and underscores may stand inside a label.
const hostChar = /[^\p{White_Space}\p{Cc}!-/:-@[-`{-~]/u;
const asciiLetterOrDigit = /[a-z0-9]/i;

const isPathChar = (char: string) =>
  !whitespace.test(char) && !"<>()?".includes(char);
// A link does not end in one of these, so that the full stop after a link
// is not part of it.
const endsPath = (char: string) =>
  isPathChar(char) && !"!*\"'「」;:=,.$%[]~&|".includes(char);
const isQueryChar = (char: string) =>
  /[a-z0-9!?*'();:&=+$/%#[\]\-_.,~|@^]/i.test(char) ||
  (char > "\u009f" && !whitespace.test(char));
const endsQuery = (char: string) =>
  /[a-z0-9_&=#/-]/i.test(char) || (char > "\u009f" && !whitespace.test(char));

/**
 * Where the host of a link ends, given where it starts, or -1 if there is
 * no host that Mastodon accepts: labels, dots, and a top-level domain that
 * is not followed by something that would make it longer.
 */
function hostEnd(text: string, start: number): number {
  let runEnd = start;
  for (let char = at(text, runEnd); char !== ""; char = at(text, runEnd)) {
    if (!hostChar.test(char) && !"._-".includes(char)) break;
    runEnd += char.length;
  }
  // The last dot that a top-level domain follows decides. An earlier one is
  // tried when what follows a later one is none: "example.com.日本".
  for (
    let dot = text.lastIndexOf(".", runEnd - 1);
    dot > start;
    dot = text.lastIndexOf(".", dot - 1)
  ) {
    const rest = text.slice(dot + 1, runEnd);
    const punycode = /^xn--[0-9a-z]+/i.exec(rest)?.[0];
    const letters = /^[a-z]{2,}/i.exec(rest)?.[0];
    const next = (length: number) => text.charAt(dot + 1 + length);
    let end = -1;
    if (letters && !/[0-9a-z@+-]/i.test(next(letters.length))) {
      end = dot + 1 + letters.length;
    } else if (punycode) {
      end = dot + 1 + punycode.length;
    }
    if (end < 0) continue;
    const labels = text.slice(start, dot).split(".");
    const valid = labels.every((label) => {
      const chars = Array.from(label);
      const first = chars[0];
      const last = chars.at(-1);
      return (
        first !== undefined &&
        last !== undefined &&
        hostChar.test(first) &&
        hostChar.test(last)
      );
    });
    if (valid) return end;
  }
  return -1;
}

/** The character at `index`, whole also where it takes two code units. */
function at(text: string, index: number): string {
  const codePoint = text.codePointAt(index);
  return codePoint === undefined ? "" : String.fromCodePoint(codePoint);
}

/**
 * Where a pair of parentheses that starts at `start` ends, or -1. A link
 * may hold a pair, with at most one more pair inside it, and neither is
 * empty: "(a)" and "(a(b)c)".
 */
function balancedEnd(text: string, start: number): number {
  let index = start + 1;
  /** Skips the path characters at `index` and says how many there were. */
  const run = () => {
    const from = index;
    while (isPathChar(at(text, index)) && at(text, index) !== "") {
      index += at(text, index).length;
    }
    return index - from;
  };
  const outer = run();
  if (at(text, index) === ")") return outer > 0 ? index + 1 : -1;
  if (at(text, index) !== "(") return -1;
  index++;
  if (run() === 0 || at(text, index) !== ")") return -1;
  index++;
  run();
  return at(text, index) === ")" ? index + 1 : -1;
}

/** Where the link that starts at `start`, with its protocol, ends, or -1. */
function linkEnd(text: string, start: number, afterProtocol: number): number {
  // Not in the middle of a word, a mention, a hashtag or a cashtag.
  if (start > 0) {
    const before = text.charAt(start - 1);
    if (asciiLetterOrDigit.test(before) || "@＠$#＃".includes(before)) {
      return -1;
    }
  }

  let end = hostEnd(text, afterProtocol);
  if (end < 0) return -1;
  const port = /^:[0-9]+/.exec(text.slice(end))?.[0];
  if (port) end += port.length;

  if (text.charAt(end) === "/") {
    let index = end + 1;
    end = index;
    for (let char = at(text, index); char !== ""; char = at(text, index)) {
      if (char === "(") {
        const closed = balancedEnd(text, index);
        if (closed < 0) break;
        index = closed;
        end = index;
      } else if (isPathChar(char)) {
        index += char.length;
        if (endsPath(char)) end = index;
      } else {
        break;
      }
    }
  }

  if (text.charAt(end) === "?") {
    let index = end + 1;
    let queryEnd = -1;
    for (let char = at(text, index); char !== ""; char = at(text, index)) {
      if (!isQueryChar(char)) break;
      index += char.length;
      if (endsQuery(char)) queryEnd = index;
    }
    if (queryEnd > 0) end = queryEnd;
  }
  return end;
}

/** The links in `text`: what begins with "http://" or "https://". */
export function findLinks(text: string): Range[] {
  const links: Range[] = [];
  const protocol = /https?:\/\//gi;
  for (let match = protocol.exec(text); match; match = protocol.exec(text)) {
    const end = linkEnd(text, match.index, match.index + match[0].length);
    if (end < 0) continue;
    links.push({ start: match.index, end });
    protocol.lastIndex = end;
  }
  return links;
}

// What Ruby calls a word character.
const word = String.raw`[\p{L}\p{M}\p{Nd}\p{Pc}]`;
const mention = new RegExp(
  `(?<![=/]|${word})@((?:[a-z0-9_]+(?:[.-]+[a-z0-9_]+)*)(?:@${word}+(?:[.-]+${word}+)*)?)`,
  "giu",
);
// After a mention there is no "@", no accented letter and no "://".
const notAfterMention =
  /^(?:[@＠]|[\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u00FF\u0100-\u024F\u0253-\u0254\u0256-\u0257\u0259\u025B\u0263\u0268\u026F\u0272\u0289\u028B\u02BB\u1E00-\u1EFF]|[\u0300-\u036F]|:\/\/)/u;

// Extractor::MAX_DOMAIN_LENGTH: what has a longer domain is no mention.
const longestDomain = 253;

/** The mentions in `text`, each with its name and its domain, if it has one. */
function findMentions(
  text: string,
): (Range & { username: string; domain: string | undefined })[] {
  const mentions: (Range & {
    username: string;
    domain: string | undefined;
  })[] = [];
  for (const match of text.matchAll(mention)) {
    const end = match.index + match[0].length;
    if (notAfterMention.test(text.slice(end))) continue;
    const [username = "", domain] = (match[1] ?? "").split("@");
    // Ruby's `length` is the number of code points, not of code units.
    if ([...(domain ?? "")].length > longestDomain) continue;
    mentions.push({ start: match.index, end, username, domain });
  }
  return mentions;
}

/**
 * The text of a status as Mastodon saves it: every mention of an account
 * that it finds is written the way the account is. `acctOf` is given the
 * name and the domain of a mention, the domain undefined if it has none,
 * and returns what Mastodon calls the `acct` of the account: its name for
 * one of the instance's own, name and domain for one from elsewhere. It
 * returns undefined for nobody, and that mention stays as it was typed.
 *
 * So "@ADA@mastodon.example" posted on mastodon.example is saved as "@ada",
 * and the source of the status no longer is the text that was sent.
 *
 * From app/services/process_mentions_service.rb. It goes by the pattern of
 * a mention alone, Account::MENTION_RE, and not by the rules that decide
 * which mention is counted without its domain.
 */
export function rewriteMentions(
  text: string,
  acctOf: (username: string, domain: string | undefined) => string | undefined,
): string {
  return text.replace(mention, (typed: string, name: string) => {
    const [username = "", domain] = name.split("@");
    const acct = acctOf(username, domain);
    return acct === undefined ? typed : `@${acct}`;
  });
}

// GUESS: that Ruby, which Mastodon counts with, and this runtime find the
// same grapheme clusters. Both follow Unicode, in versions that may differ.
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The length of `text` as Mastodon counts it against the limit: every link
 * as `reservedPerUrl` characters, a mention without its domain, the rest
 * in grapheme clusters.
 */
export function countableLength(text: string, reservedPerUrl: number): number {
  const links = findLinks(text);
  // Where a link and a mention overlap, the one that starts first stays.
  const entities = [
    ...links.map((link) => ({ ...link, as: "x".repeat(reservedPerUrl) })),
    ...findMentions(text).map((found) => ({
      ...found,
      as: `@${found.username}`,
    })),
  ].sort((a, b) => a.start - b.start);

  let rewritten = "";
  let position = 0;
  for (const entity of entities) {
    if (entity.start < position) continue;
    rewritten += text.slice(position, entity.start) + entity.as;
    position = entity.end;
  }
  rewritten += text.slice(position);

  let length = 0;
  for (const _ of graphemes.segment(rewritten)) length++;
  return length;
}

// A hashtag, as in app/models/tag.rb: "#" or its full-width form, not
// after a letter, a digit, "=", "/" or ")", and then a name. A name is
// made of word characters, with a letter among them. Inside it, and not
// at its ends, it may also have one of three separators: the middle dot,
// the Katakana middle dot and the zero width non-joiner.
// GUESS: the pattern as of Mastodon 4.5, written down from memory of the
// code and not from the documentation, which only says "#" and a word.
const tagWord = String.raw`[\p{L}\p{M}\p{Nd}\p{Pc}]`;
const tagInner = String.raw`[\p{L}\p{M}\p{Nd}\p{Pc}\u00B7\u30FB\u200C]`;
const tagLetter = String.raw`[\p{L}\p{M}]`;
const hashtag = new RegExp(
  String.raw`(?<![=/)\p{L}\p{M}\p{Nd}])[#＃]` +
    `(${tagWord}${tagInner}*[\\p{L}\\p{M}\\u00B7\\u30FB\\u200C_]${tagInner}*${tagWord}` +
    `|${tagWord}*${tagLetter}${tagWord}*)`,
  "gu",
);

/** The hashtags in `text`, each with its name. */
function findHashtags(text: string): (Range & { name: string })[] {
  return [...text.matchAll(hashtag)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    name: match[1] ?? "",
  }));
}

/** An account that a mention names, as the instance that shows it has it. */
export type Mentioned = {
  id: string;
  username: string;
  /** The name alone for an account of the instance, with its domain otherwise. */
  acct: string;
  url: string;
};

/**
 * What Mastodon makes of a text that it has saved: its links, the
 * mentions of the accounts that it finds, and its hashtags, in the order
 * of the text. `accountOf` is given the name and the domain of a mention
 * and returns the account, or undefined for nobody: such a mention stays
 * text.
 *
 * From app/lib/text_formatter.rb and app/lib/extractor.rb: where two of
 * them overlap, the one that starts first stays.
 */
export function findEntities(
  text: string,
  accountOf: (
    username: string,
    domain: string | undefined,
  ) => Mentioned | undefined,
): {
  entities: SimEntity[];
  mentions: Mentioned[];
  /** The names of the tags, as they are written. */
  tags: string[];
} {
  const mentions: Mentioned[] = [];
  const tags: string[] = [];
  const candidates: (SimEntity & { account?: Mentioned; name?: string })[] = [
    ...findLinks(text).map(({ start, end }) => ({
      kind: "link" as const,
      start,
      end,
      target: text.slice(start, end),
    })),
    ...findMentions(text).flatMap(({ start, end, username, domain }) => {
      const account = accountOf(username, domain);
      return account
        ? [
            {
              kind: "mention" as const,
              start,
              end,
              target: account.id,
              account,
            },
          ]
        : [];
    }),
    ...findHashtags(text).map(({ start, end, name }) => ({
      kind: "hashtag" as const,
      start,
      end,
      target: name,
      name,
    })),
  ].sort((a, b) => a.start - b.start);
  const entities: SimEntity[] = [];
  let position = 0;
  for (const { account, name, ...entity } of candidates) {
    if (entity.start < position) continue;
    position = entity.end;
    entities.push(entity);
    if (account && !mentions.some(({ id }) => id === account.id)) {
      mentions.push(account);
    }
    if (name !== undefined && !tags.includes(name)) tags.push(name);
  }
  return { entities, mentions, tags };
}

/** A link as Mastodon writes it: with the parts it does not show hidden. */
function linkHtml(url: string): string {
  const prefix = /^https?:\/\/(?:www\.)?/i.exec(url)?.[0] ?? "";
  const rest = Array.from(url.slice(prefix.length));
  const shown = rest.slice(0, 30).join("");
  const hidden = rest.slice(30).join("");
  return `<a href="${escapeHtml(url)}" target="_blank" rel="nofollow noopener" translate="no"><span class="invisible">${escapeHtml(prefix)}</span><span class="${hidden ? "ellipsis" : ""}">${escapeHtml(shown)}</span><span class="invisible">${escapeHtml(hidden)}</span></a>`;
}

/**
 * The `content` of a status: its text as HTML. Blank lines part
 * paragraphs, other line breaks become `<br />`, and links, mentions and
 * hashtags become `<a>`, from app/lib/text_formatter.rb. `domain` is that
 * of the instance, where the pages of its tags are.
 *
 * A mention shows as the name of the account without its domain, also
 * for an account from elsewhere: the text that the HTML stands for is not
 * the text that was saved there.
 */
export function renderContent(
  text: string,
  domain: string,
  accountOf: (
    username: string,
    domain: string | undefined,
  ) => Mentioned | undefined,
): string {
  const normalized = text.replace(/\r\n?/g, "\n");
  const { entities } = findEntities(normalized, accountOf);
  const mentioned = new Map<string, Mentioned>();
  for (const { start, end, username, domain: named } of findMentions(
    normalized,
  )) {
    const account = accountOf(username, named);
    if (account) mentioned.set(`${start}-${end}`, account);
  }
  let html = "<p>";
  let position = 0;
  /** Text between two entities: its line breaks are the only markup. */
  const plain = (from: number, to: number) =>
    escapeHtml(normalized.slice(from, to))
      .replace(/\n\n+/g, "</p><p>")
      .replaceAll("\n", "<br />");
  for (const { kind, start, end } of entities) {
    html += plain(position, start);
    const written = normalized.slice(start, end);
    if (kind === "link") {
      html += linkHtml(written);
    } else if (kind === "mention") {
      const account = mentioned.get(`${start}-${end}`);
      html += account
        ? `<span class="h-card" translate="no"><a href="${escapeHtml(account.url)}" class="u-url mention">@<span>${escapeHtml(account.username)}</span></a></span>`
        : escapeHtml(written);
    } else {
      const name = written.slice(1);
      html += `<a href="https://${escapeHtml(domain)}/tags/${encodeURIComponent(name.toLowerCase())}" class="mention hashtag" rel="tag">#<span>${escapeHtml(name)}</span></a>`;
    }
    position = end;
  }
  return `${html}${plain(position, normalized.length)}</p>`;
}
