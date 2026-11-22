import { type Fetch, type LinkCard, linkCardSchema } from "@pigy/core";
import { ProviderError } from "./errors.ts";
import { publicUrl } from "./host.ts";
import { decodeEntities } from "./html.ts";
import { sendFollowing } from "./http.ts";

/**
 * Reads the page that a link leads to, for the card of the link: what the
 * page says of itself in its head, as text. Bluesky and LinkedIn show a
 * card only if whoever posts sends one, so pigy reads the page, when a
 * post goes out and in the editor before.
 *
 * The address is one that a person wrote into a post, and the page is
 * anybody's. So this is the most guarded request that pigy makes:
 *
 * - **Where it goes.** Only to an HTTPS address at a public host,
 *   `publicUrl` of host.ts: no address of a private network, no IP
 *   address, no port. A page may send the request on, as a shortened link
 *   does, a few times and only to such an address again, and the whole
 *   way has the time of one request: `sendFollowing` of http.ts.
 * - **What it carries.** Nothing: no credentials, no cookie, nothing of
 *   the person or of the post. It is a `GET` that changes nothing.
 * - **What it reads.** Only an answer that says that it is HTML in UTF-8,
 *   and of that the first `maxBytes`: the head of a page is at its
 *   beginning, and the rest is not read.
 * - **What it takes.** The title and the description, from the Open Graph
 *   tags or, without them, from `<title>` and the description of the
 *   page. They are found by looking through the text of the page:
 *   nothing of it is run, loaded or built into a document. What is taken
 *   is text, without control characters, cut to a length, and is shown as
 *   text wherever it goes. The picture of a page is not taken: see
 *   PLAN.md section 6, "Links, mentions and hashtags".
 *
 * A page that cannot be read is no failure of anything: the link has no
 * card then. So this returns null for whatever goes wrong at the other
 * end, and for an address that it does not ask. Only what is no failure
 * of a network comes out as it is, as from every request of an adapter.
 */

export type CardLimits = {
  /** How long the whole way to the page may take, in milliseconds. */
  timeoutMs: number;
  /** How much of the page is read, in bytes. */
  maxBytes: number;
  /** How often the request may be sent on. */
  hops: number;
};

export const cardLimits: CardLimits = {
  timeoutMs: 5000,
  maxBytes: 256 * 1024,
  hops: 3,
};

// What a card holds of a page at most, in UTF-16 code units: less than
// `linkCardSchema` takes, so that a card that is made here always passes.
const maxTitleLength = 200;
const maxDescriptionLength = 500;

// How many `<meta>` tags of a page are looked at, and how long one may
// be. A page that has more, or longer ones, is not what this is for, and
// the work that a page can make pigy do has an end.
const maxMetaTags = 200;
const maxTagLength = 4096;

/**
 * `text` as plain text of at most `maxLength`: character references
 * resolved, without the characters that are no text, and with its
 * whitespace as single spaces.
 */
function plain(text: string, maxLength: number): string {
  let cut = "";
  for (const character of decodeEntities(text).replace(/\s+/g, " ").trim()) {
    if (isNoText(character.codePointAt(0) ?? 0)) continue;
    if (cut.length + character.length > maxLength) break;
    cut += character;
  }
  return cut.trim();
}

/**
 * Whether a code point is none that a title is written with: a control
 * character, or one that turns the direction of a text around, with
 * which a title could rearrange what stands next to it.
 */
function isNoText(codePoint: number): boolean {
  return (
    codePoint < 0x20 ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    codePoint === 0xfeff
  );
}

/**
 * `html` without its comments, scripts and styles, so that what is
 * written in one of them is not taken for a tag of the page. One pass:
 * the work is bounded by the length of the page, whatever the page is.
 */
function withoutCode(html: string): string {
  const lower = html.toLowerCase();
  const blocks: [open: string, close: string][] = [
    ["<!--", "-->"],
    ["<script", "</script"],
    ["<style", "</style"],
  ];
  let kept = "";
  let position = 0;
  while (position < html.length) {
    let next = -1;
    let closing = "";
    for (const [open, close] of blocks) {
      const at = lower.indexOf(open, position);
      if (at !== -1 && (next === -1 || at < next)) {
        next = at;
        closing = close;
      }
    }
    if (next === -1) break;
    kept += html.slice(position, next);
    const end = lower.indexOf(closing, next);
    // One that is not closed takes the rest of the page with it.
    if (end === -1) return kept;
    position = end + closing.length;
  }
  return kept + html.slice(position);
}

/** The attributes of the tag whose text is `tag`, with their names in lower case. */
function attributesOf(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of tag.matchAll(
    /([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g,
  )) {
    const name = (match[1] ?? "").toLowerCase();
    if (!attributes.has(name)) {
      attributes.set(name, match[2] ?? match[3] ?? match[4] ?? "");
    }
  }
  return attributes;
}

/** What the `<meta>` tags of `html` say, by `property` or `name`, the first of each. */
function metaOf(html: string): Map<string, string> {
  const lower = html.toLowerCase();
  const said = new Map<string, string>();
  let position = 0;
  for (let count = 0; count < maxMetaTags; count++) {
    const start = lower.indexOf("<meta", position);
    if (start === -1) break;
    // The end of the tag: the first ">" that is not within quotes.
    let end = -1;
    let quote = "";
    const limit = Math.min(html.length, start + maxTagLength);
    for (let index = start + 5; index < limit; index++) {
      const character = html[index];
      if (quote) {
        if (character === quote) quote = "";
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        end = index;
        break;
      }
    }
    if (end === -1) {
      position = start + 5;
      continue;
    }
    position = end + 1;
    const attributes = attributesOf(html.slice(start + 5, end));
    const key = (
      attributes.get("property") ??
      attributes.get("name") ??
      ""
    ).toLowerCase();
    const content = attributes.get("content");
    if (key && content !== undefined && !said.has(key)) said.set(key, content);
  }
  return said;
}

/** What stands in the first `<title>` of `html`, or undefined. */
function titleOf(html: string): string | undefined {
  const lower = html.toLowerCase();
  const start = lower.indexOf("<title");
  if (start === -1) return undefined;
  const open = lower.indexOf(">", start);
  if (open === -1) return undefined;
  const close = lower.indexOf("</title", open);
  return close === -1 ? undefined : html.slice(open + 1, close);
}

/**
 * The card that the page `html` at `url` makes of itself, or null if it
 * says nothing that a card could show.
 */
export function cardOf(url: string, html: string): LinkCard | null {
  const page = withoutCode(html);
  const meta = metaOf(page);
  const title = plain(
    meta.get("og:title") ?? meta.get("twitter:title") ?? titleOf(page) ?? "",
    maxTitleLength,
  );
  const description = plain(
    meta.get("og:description") ??
      meta.get("twitter:description") ??
      meta.get("description") ??
      "",
    maxDescriptionLength,
  );
  if (title === "" && description === "") return null;
  const card = linkCardSchema.safeParse({
    url,
    // A card is headed by something: the host, where the page names
    // nothing.
    title: title || new URL(url).host,
    description,
  });
  return card.success ? card.data : null;
}

/** Whether a `Content-Type` is that of a page that this reads. */
function isReadablePage(contentType: string | null): boolean {
  const [type = "", ...parameters] = (contentType ?? "")
    .toLowerCase()
    .split(";")
    .map((piece) => piece.trim());
  if (type !== "text/html" && type !== "application/xhtml+xml") return false;
  const charset = parameters
    .find((parameter) => parameter.startsWith("charset="))
    ?.slice("charset=".length)
    .replace(/^"|"$/g, "");
  // The body is read as UTF-8, which a page that names no encoding
  // nearly always is. One that names another would come out garbled.
  return charset === undefined || charset === "utf-8" || charset === "utf8";
}

/**
 * The card of the link `link`, read from its page with `fetch`, or null
 * if there is none to be had: the top of this file has the rules.
 */
export async function fetchLinkCard(
  fetch: Fetch,
  link: string,
  limits: CardLimits = cardLimits,
): Promise<LinkCard | null> {
  let address: URL;
  try {
    address = new URL(link);
  } catch {
    return null;
  }
  // What stands after "#" is for the browser, and is not sent.
  address.hash = "";
  const url = publicUrl(address.href);
  if (url === null) return null;
  try {
    const answer = await sendFollowing(
      fetch,
      url,
      {
        method: "GET",
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": "pigy (link preview)",
        },
      },
      {
        timeoutMs: limits.timeoutMs,
        maxBytes: limits.maxBytes,
        partial: true,
      },
      limits.hops,
    );
    if (
      answer.status !== 200 ||
      !isReadablePage(answer.headers.get("Content-Type"))
    ) {
      return null;
    }
    return cardOf(link, answer.text);
  } catch (error) {
    // No answer, an answer that pigy does not read, or a way to the page
    // that it does not follow.
    if (error instanceof ProviderError) return null;
    throw error;
  }
}
