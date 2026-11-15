import { escapeHtml } from "../world/pages.ts";

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

/** The mentions in `text`, each with the name before the domain. */
function findMentions(text: string): (Range & { username: string })[] {
  const mentions: (Range & { username: string })[] = [];
  for (const match of text.matchAll(mention)) {
    const end = match.index + match[0].length;
    if (notAfterMention.test(text.slice(end))) continue;
    const [username = "", domain = ""] = (match[1] ?? "").split("@");
    // Ruby's `length` is the number of code points, not of code units.
    if ([...domain].length > longestDomain) continue;
    mentions.push({ start: match.index, end, username });
  }
  return mentions;
}

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
 * paragraphs, other line breaks become `<br />`, links become `<a>`.
 *
 * Mentions and hashtags stay plain text here. Mastodon links them too,
 * which makes no difference to the text that the HTML stands for.
 */
export function renderContent(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n\n+/)
    .map((paragraph) => {
      const lines = paragraph.split("\n").map((line) => {
        let html = "";
        let position = 0;
        for (const { start, end } of findLinks(line)) {
          html += escapeHtml(line.slice(position, start));
          html += linkHtml(line.slice(start, end));
          position = end;
        }
        return html + escapeHtml(line.slice(position));
      });
      return `<p>${lines.join("<br />")}</p>`;
    })
    .join("");
}
