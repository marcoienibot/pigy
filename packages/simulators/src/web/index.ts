import type { Fetch } from "@pigy/core";
import { escapeHtml } from "../world/pages.ts";

/**
 * A tiny simulated web: a handful of pages under names that cannot exist
 * on the internet, for the links of a post in a sandbox to lead to. pigy
 * reads such a page to make the card of a link, and so do the simulated
 * networks that make their cards themselves. And a few images, for the
 * public API of a sandbox to fetch where a post names one by its address.
 *
 * It answers `GET` over HTTPS on its own hosts, with what a page says of
 * itself in its head, the way pages do: Open Graph tags, a `<title>`, a
 * description. It keeps nothing and takes no faults: a page is there or
 * it is not. Like every simulator it makes no requests, and fails for a
 * host that is not its own.
 */

/** A page of the simulated web. */
export type WebPage = {
  /** Its address. */
  url: string;
  /** What `<title>` says, if the page has one. */
  title?: string;
  /** What `og:title` says, if the page has one. */
  ogTitle?: string;
  /** What `<meta name="description">` says. */
  description?: string;
  /** What `og:description` says. */
  ogDescription?: string;
};

/** The hosts of the simulated web, all under `.test`. */
export const webHosts = [
  "example.test",
  "blog.example.test",
  "news.example.test",
] as const;

/**
 * The pages. The address of the first is what the app offers as a link to
 * try in a sandbox.
 */
export const webPages: readonly WebPage[] = [
  {
    url: "https://example.test/",
    title: "Example",
    ogTitle: "The example page",
    ogDescription:
      "A page of the simulated web of a sandbox, for the links of a post to lead to.",
  },
  {
    url: "https://blog.example.test/first-post",
    title: "The first post | Example blog",
    ogTitle: "The first post",
    ogDescription: "What a blog of the simulated web has to say for itself.",
    description: "A description that the Open Graph one takes the place of.",
  },
  {
    // A page without Open Graph tags: its title and its description are
    // what a card is made of.
    url: "https://news.example.test/story",
    title: "A story from the simulated news",
    description: "Nothing happened today, and here is all of it.",
  },
  {
    // What a page says of itself is anybody's to write. This one writes
    // markup, which whoever shows a card has to show as the text it is.
    url: "https://example.test/markup",
    ogTitle: '<b>Bold</b> claims & <script>alert("card")</script>',
    ogDescription: "<img src=x onerror=alert(1)> A description with markup.",
  },
];

// A page that sends whoever asks on to another, as a shortened link does.
const moved: Readonly<Record<string, string>> = {
  "https://example.test/moved": "https://blog.example.test/first-post",
  "https://example.test/images/moved": "https://example.test/images/sunset.png",
};

// What is no page: a file of another type.
const files: Readonly<Record<string, string>> = {
  "https://example.test/file.pdf": "application/pdf",
};

/**
 * A PNG of 120 by 80 pixels in one colour, which a decoder draws: what
 * the images of the simulated web are.
 */
const sunset = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAHgAAABQCAIAAABd+SbeAAAAgUlEQVR42u3QQQ0AAAgEoItmYyNqC+eDjQRkujgQBaJFI1q0aAuiRSNatGgLokUjWrRoRItGtGjRiBaNaNGiES0a0aJFI1o0okWLRrRoRIsWjWjRiBYtGtGiES1aNKJFI1q0aESLRrRo0YgWjWjRohEtGtGiRSNaNKJFi0a0aET/sW0XYTmcnBBYAAAAAElFTkSuQmCC",
  ),
  (character) => character.charCodeAt(0),
);

/**
 * The images of the simulated web, by what each is for: one that is
 * there, one whose address sends the request on to it, one whose answer
 * says that it is a picture and is a page, and one whose answer says
 * that it is text and is the picture.
 */
export const webImages = {
  image: "https://example.test/images/sunset.png",
  moved: "https://example.test/images/moved",
  notAnImage: "https://example.test/images/not-an-image.png",
  mislabelled: "https://example.test/images/sunset.txt",
} as const;

// What answers at each of them, with the type that the answer names.
const images: Readonly<
  Record<string, { body: Uint8Array | string; type: string }>
> = {
  [webImages.image]: { body: sunset, type: "image/png" },
  [webImages.notAnImage]: {
    body: "<!doctype html><title>Not an image</title>",
    type: "image/png",
  },
  [webImages.mislabelled]: { body: sunset, type: "text/plain" },
};

/** The address of `url` as the simulated web compares it. */
function addressOf(url: string): string | undefined {
  try {
    const { origin, pathname } = new URL(url);
    return origin + pathname;
  } catch {
    return undefined;
  }
}

/**
 * The page of the simulated web at `url`, followed to where it has moved,
 * or undefined if there is none: for a simulated network that makes the
 * card of a link itself, as the real one would by reading the page.
 */
export function webPageAt(url: string): WebPage | undefined {
  const address = addressOf(url);
  if (address === undefined) return undefined;
  const at = moved[address] ?? address;
  return webPages.find((page) => page.url === at);
}

const meta = (attribute: string, name: string, content: string | undefined) =>
  content === undefined
    ? ""
    : `<meta ${attribute}="${name}" content="${escapeHtml(content)}">\n`;

function render(page: WebPage): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${page.title === undefined ? "" : `<title>${escapeHtml(page.title)}</title>\n`}${meta("name", "description", page.description)}${meta("property", "og:title", page.ogTitle)}${meta("property", "og:description", page.ogDescription)}</head>
<body>
<p>A page of the simulated web of a pigy sandbox.</p>
</body>
</html>`;
}

export type WebSimulator = {
  /** Answers a request to a host of the simulated web. */
  fetch: Fetch;
  /** Whether `host` is one of the simulated web. */
  owns(host: string): boolean;
};

export function createWebSimulator(): WebSimulator {
  const owns = (host: string) => (webHosts as readonly string[]).includes(host);
  return {
    owns,
    async fetch(input, init) {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.protocol !== "https:" || url.port !== "" || !owns(url.host)) {
        throw new TypeError(`The simulated web has no host ${url.host}`);
      }
      const text = (status: number, body: string, type = "text/plain") =>
        new Response(body, {
          status,
          headers: { "Content-Type": `${type}; charset=utf-8` },
        });
      if (request.method !== "GET") {
        return text(405, "The simulated web only hands out its pages.");
      }
      const address = url.origin + url.pathname;
      const target = moved[address];
      if (target !== undefined) {
        return new Response(null, {
          status: 301,
          headers: { Location: target },
        });
      }
      const image = images[address];
      if (image !== undefined) {
        return new Response(image.body as Uint8Array<ArrayBuffer> | string, {
          headers: { "Content-Type": image.type },
        });
      }
      const file = files[address];
      if (file !== undefined) {
        return new Response("%PDF-1.4 simulated", {
          headers: { "Content-Type": file },
        });
      }
      const page = webPages.find((candidate) => candidate.url === address);
      return page
        ? text(200, render(page), "text/html")
        : text(404, "The simulated web has no such page.");
    },
  };
}
