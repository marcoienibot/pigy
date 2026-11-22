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
 * - **What it reads.** Only an answer with the status 200 that says that
 *   it is HTML in UTF-8, and of that the first `maxBytes`: the head of a
 *   page is at its beginning, and the rest is not read. That is decided
 *   by the status and the headers, before anything of a body is read:
 *   the body of an error page, of a file and of an answer that sends the
 *   request on is given up unread. A page that names another encoding
 *   for itself, in a `<meta>` tag, has no card either, unless its answer
 *   said UTF-8.
 * - **What it takes.** The title and the description, from the Open Graph
 *   tags or, without them, from `<title>` and the description of the
 *   page. They are found by looking through the text of the page once,
 *   `readPage`, in work that is bounded by its length: nothing of it is
 *   run, loaded or built into a document, and no timer could interrupt
 *   the looking. What is taken
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

// How much of a page is looked through, in UTF-16 code units, and how
// many of its tags. `fetchLinkCard` reads no more than `maxBytes` of a
// page, which is at least as many bytes as characters: the first is the
// same bound for whoever hands `cardOf` a text of their own. The second
// is far more than a page has before its head ends.
const maxPageLength = cardLimits.maxBytes;
const maxTags = 20_000;

/**
 * How many characters `readPage` may look at for a page of `length`. It
 * looks at each once and at those of a `<meta>` tag three times, to find
 * its end, to cut it out and to read its attributes, so a page stays far
 * below this whatever it is. It is the second line of defence: a mistake
 * in the scan that made it look at a stretch again and again would end
 * here and not in seconds of a processor, which no timer interrupts.
 */
const maxWork = (length: number) => 4 * length + 4096;

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
    // The Arabic letter mark, and the marks of both directions.
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    codePoint === 0xfeff
  );
}

/**
 * `text` with the letters A to Z in lower case and everything else as it
 * is. The names of HTML are compared this way, and never with
 * `toLowerCase`: that changes other letters too, and the length of a text
 * with them, so that a place in the lowered text is not the same place
 * in the text.
 */
const asciiLower = (text: string) =>
  text.replace(/[A-Z]/g, (letter) =>
    String.fromCharCode(letter.charCodeAt(0) + 32),
  );

const isSpace = (character: string | undefined) =>
  character === " " ||
  character === "\n" ||
  character === "\t" ||
  character === "\r" ||
  character === "\f";

/**
 * The attributes of the tag whose text is `tag`, with their names in
 * lower case, the first of each name. One pass: a name is read once,
 * whether or not a value follows it.
 */
function attributesOf(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const { length } = tag;
  let at = 0;
  while (at < length) {
    if (isSpace(tag[at]) || tag[at] === "/") {
      at++;
      continue;
    }
    // A name goes up to whitespace, "=" or "/". A "=" that begins one is
    // part of it, as in the HTML standard, so that every round moves on.
    const begins = at++;
    while (
      at < length &&
      !isSpace(tag[at]) &&
      tag[at] !== "=" &&
      tag[at] !== "/"
    ) {
      at++;
    }
    const name = asciiLower(tag.slice(begins, at));
    while (isSpace(tag[at])) at++;
    let value = "";
    if (tag[at] === "=") {
      at++;
      while (isSpace(tag[at])) at++;
      const quote = tag[at];
      if (quote === '"' || quote === "'") {
        const closes = tag.indexOf(quote, at + 1);
        const ends = closes === -1 ? length : closes;
        value = tag.slice(at + 1, ends);
        at = ends + 1;
      } else {
        const from = at;
        while (at < length && !isSpace(tag[at])) at++;
        value = tag.slice(from, at);
      }
    }
    if (!attributes.has(name)) attributes.set(name, value);
  }
  return attributes;
}

/** The encoding that a `Content-Type`, of a header or a tag, names. */
function charsetOf(contentType: string): string | undefined {
  return /charset\s*=\s*["']?([^"';\s]+)/i.exec(contentType)?.[1];
}

/** Whether `charset` is a name of UTF-8, which is how a page is read. */
const isUtf8 = (charset: string) => /^utf-?8$/i.test(charset.trim());

// The tags that the scan knows, each with what follows its "<". The
// longest is seven characters.
const knownTags = [
  "script",
  "style",
  "meta",
  "title",
  "/head",
  "body",
  "svg",
] as const;

/** The tag that begins at `open` of `html`, if it is one of `knownTags`. */
function knownTagAt(html: string, open: number) {
  const begins = asciiLower(html.slice(open + 1, open + 9));
  return knownTags.find(
    (name) =>
      begins.startsWith(name) &&
      // The name ends there: "<metadata>" is no "<meta>".
      !/[a-z0-9]/.test(begins[name.length] ?? ""),
  );
}

/** What `readPage` found in a page. */
export type PageHead = {
  /** What the `<meta>` tags say, by `property` or `name`, the first of each. */
  meta: Map<string, string>;
  /** What stands in the first `<title>` of the head. */
  title: string | undefined;
  /** The encoding that the page names for itself in a `<meta>` tag. */
  charset: string | undefined;
  /** How many characters were looked at: what the tests bound. */
  work: number;
};

/**
 * What the page `html` says of itself: its `<meta>` tags, its title and
 * the encoding that it names. Nothing of it is run or built into a
 * document: this goes through its text once, from the beginning to the
 * end, and looks at what follows each "<".
 *
 * - A comment, a script and a style are passed over whole, so that what
 *   is written in one is not taken for a tag of the page. One that is
 *   not closed takes the rest of the page with it.
 * - The title is the first `<title>` before the head ends, which is at
 *   `</head>`, `<body>` or `<svg>`: a picture in the body has titles of
 *   its own, which are no title of the page.
 * - A `<meta>` tag ends at the first ">" outside of quotes, and is given
 *   up after `maxTagLength`, with what was looked through for its end.
 *
 * Every search goes forward from where the scan stands, and the scan
 * moves past what a search found. A search that finds nothing ends the
 * scan, or is not made a second time. So the work is bounded by the
 * length of the page, whatever the page is, and `maxWork` holds it to
 * that.
 */
export function readPage(html: string): PageHead {
  const page =
    html.length > maxPageLength ? html.slice(0, maxPageLength) : html;
  const head: PageHead = {
    meta: new Map(),
    title: undefined,
    charset: undefined,
    work: 0,
  };
  const budget = maxWork(page.length);
  // The patterns are of this call alone: each keeps where it searches
  // from.
  const closes = {
    script: /<\/script/gi,
    style: /<\/style/gi,
    title: /<\/title/gi,
  };
  let inHead = true;
  let titleCloses = true;
  let metaTags = 0;
  let tags = 0;
  let position = 0;
  while (position < page.length) {
    const open = page.indexOf("<", position);
    if (open === -1) {
      head.work += page.length - position;
      break;
    }
    head.work += open + 1 - position;
    if (++tags > maxTags || head.work > budget) break;
    position = open + 1;

    if (page.startsWith("<!--", open)) {
      // "<!-->" is a comment too: its end may begin within its beginning.
      const end = page.indexOf("-->", open + 2);
      if (end === -1) break;
      head.work += end - open;
      position = end + 3;
      continue;
    }
    const tag = knownTagAt(page, open);
    if (tag === undefined) continue;

    if (tag === "/head" || tag === "body" || tag === "svg") {
      inHead = false;
    } else if (tag === "script" || tag === "style") {
      const pattern = closes[tag];
      pattern.lastIndex = position;
      const end = pattern.exec(page);
      if (end === null) break;
      head.work += end.index - open;
      position = end.index + end[0].length;
    } else if (tag === "title") {
      const begins = page.indexOf(">", position);
      if (begins === -1) break;
      head.work += begins - open;
      position = begins + 1;
      // A title that is not closed is none, and neither is any after
      // it: the search for its end is not made again.
      if (!titleCloses) continue;
      closes.title.lastIndex = position;
      const end = closes.title.exec(page);
      if (end === null) {
        head.work += page.length - position;
        titleCloses = false;
        continue;
      }
      head.work += end.index - position;
      if (head.title === undefined && inHead) {
        head.title = page.slice(position, end.index);
      }
      position = end.index + end[0].length;
    } else if (metaTags < maxMetaTags) {
      metaTags++;
      // The end of the tag: the first ">" that is not within quotes.
      let end = -1;
      let quote = "";
      const from = open + "<meta".length;
      const limit = Math.min(page.length, from + maxTagLength);
      let index = from;
      for (; index < limit; index++) {
        const character = page[index];
        if (quote) {
          if (character === quote) quote = "";
        } else if (character === '"' || character === "'") {
          quote = character;
        } else if (character === ">") {
          end = index;
          break;
        }
      }
      // Looked at once here, and twice more to read the attributes.
      head.work += (index - from) * (end === -1 ? 1 : 3);
      if (end === -1) {
        // A tag without an end, as one whose quote never closes: what
        // was looked through for its end is not looked through again.
        position = limit;
        continue;
      }
      position = end + 1;
      const attributes = attributesOf(page.slice(from, end));
      const content = attributes.get("content");
      const declared =
        attributes.get("charset") ??
        (asciiLower(attributes.get("http-equiv") ?? "") === "content-type"
          ? charsetOf(content ?? "")
          : undefined);
      head.charset ??= declared;
      const key = asciiLower(
        attributes.get("property") ?? attributes.get("name") ?? "",
      );
      if (key && content !== undefined && !head.meta.has(key)) {
        head.meta.set(key, content);
      }
    }
  }
  return head;
}

/**
 * The card that the page `html` at `url` makes of itself, or null if it
 * says nothing that a card could show.
 *
 * `html` is the page read as UTF-8. `utf8Declared` says that the answer
 * which carried it named that encoding. Without that word, a page that
 * names another encoding for itself, in a `<meta>` tag, has no card: its
 * letters would come out garbled.
 */
export function cardOf(
  url: string,
  html: string,
  { utf8Declared = false }: { utf8Declared?: boolean } = {},
): LinkCard | null {
  const { meta, title: pageTitle, charset } = readPage(html);
  if (!utf8Declared && charset !== undefined && !isUtf8(charset)) return null;
  // The first that says something: a tag that is there and empty says
  // nothing.
  const first = (maxLength: number, ...said: (string | undefined)[]) => {
    for (const text of said) {
      const cut = text === undefined ? "" : plain(text, maxLength);
      if (cut !== "") return cut;
    }
    return "";
  };
  const title = first(
    maxTitleLength,
    meta.get("og:title"),
    meta.get("twitter:title"),
    pageTitle,
  );
  const description = first(
    maxDescriptionLength,
    meta.get("og:description"),
    meta.get("twitter:description"),
    meta.get("description"),
  );
  if (title === "" && description === "") return null;
  const card = linkCardSchema.safeParse({
    url,
    // A card is headed by something: the host, where the page names
    // nothing. So every card has a title, which `linkCardSchema` holds
    // it to, and LinkedIn, which requires one of an article, gets one.
    title: title || new URL(url).host,
    description,
  });
  return card.success ? card.data : null;
}

/**
 * Whether an answer is one whose body this reads: a page, with the
 * status 200, that says that it is HTML and names no encoding but UTF-8.
 */
function isReadablePage(status: number, headers: Headers): boolean {
  if (status !== 200) return false;
  const contentType = headers.get("Content-Type") ?? "";
  const type = asciiLower(contentType.split(";")[0]?.trim() ?? "");
  if (type !== "text/html" && type !== "application/xhtml+xml") return false;
  // The body is read as UTF-8, which a page that names no encoding
  // nearly always is. One that names another would come out garbled.
  const charset = charsetOf(contentType);
  return charset === undefined || isUtf8(charset);
}

/** What `fetchLinkCard` can be told besides the link. */
export type CardOptions = {
  limits?: CardLimits;
  /**
   * The hosts of pigy itself, as `URL.host` writes them, which are never
   * asked, at first or where a page sends the request on: pigy has
   * nothing to learn from a page of its own, and a request of a Worker
   * to the zone that it is deployed on is not always one from outside,
   * as host.ts says.
   */
  ownHosts?: readonly string[];
};

/**
 * The card of the link `link`, read from its page with `fetch`, or null
 * if there is none to be had: the top of this file has the rules.
 */
export async function fetchLinkCard(
  fetch: Fetch,
  link: string,
  { limits = cardLimits, ownHosts = [] }: CardOptions = {},
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
  const foreign = (at: string) => !ownHosts.includes(new URL(at).host);
  if (url === null || !foreign(url)) return null;
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
        // Decided before anything of the body is read: an error page, a
        // file or a film is not waited for.
        reads: isReadablePage,
      },
      limits.hops,
      foreign,
    );
    if (!isReadablePage(answer.status, answer.headers)) return null;
    return cardOf(link, answer.text, {
      utf8Declared:
        charsetOf(answer.headers.get("Content-Type") ?? "") !== undefined,
    });
  } catch (error) {
    // No answer, an answer that pigy does not read, or a way to the page
    // that it does not follow.
    if (error instanceof ProviderError) return null;
    throw error;
  }
}
