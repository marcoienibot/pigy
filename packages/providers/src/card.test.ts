import type { Fetch } from "@pigy/core";
import { createWebSimulator } from "@pigy/simulators/web";
import { describe, expect, it } from "vitest";
import { cardLimits, cardOf, fetchLinkCard } from "./card.ts";

const page = (head: string) =>
  `<!doctype html><html><head>${head}</head><body><p>Text</p></body></html>`;

const html = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, {
    headers: { "Content-Type": "text/html; charset=utf-8", ...headers },
  });

/**
 * A web of the test's own: what answers at each address, and every
 * address that was asked for, in order.
 */
function web(pages: Record<string, (request: Request) => Response>) {
  const asked: Request[] = [];
  const fetch: Fetch = async (input, init) => {
    const request = new Request(input, init);
    asked.push(request);
    const answer = pages[request.url];
    // What a `fetch` does for a host that is not there.
    if (!answer) throw new TypeError(`No such host: ${request.url}`);
    return answer(request);
  };
  return { fetch, asked, urls: () => asked.map(({ url }) => url) };
}

describe("cardOf", () => {
  const url = "https://example.com/a";

  it("takes the Open Graph tags of a page before its title and its description", () => {
    expect(
      cardOf(
        url,
        page(
          '<title>Plain title</title><meta name="description" content="Plain description"><meta property="og:title" content="Graph title"><meta property="og:description" content="Graph description">',
        ),
      ),
    ).toEqual({ url, title: "Graph title", description: "Graph description" });
  });

  it("takes the title and the description of a page that has no Open Graph tags", () => {
    expect(
      cardOf(
        url,
        page(
          "<title>\n  Plain   title\n</title><meta content='Plain description' name=description>",
        ),
      ),
    ).toEqual({ url, title: "Plain title", description: "Plain description" });
  });

  it("heads a card with the host where the page names nothing", () => {
    expect(
      cardOf(url, page('<meta name="description" content="Only this">')),
    ).toEqual({ url, title: "example.com", description: "Only this" });
  });

  it("has no card for a page that says nothing of itself", () => {
    expect(cardOf(url, page(""))).toBeNull();
    expect(cardOf(url, "not a page at all")).toBeNull();
  });

  it("hands out markup in a title as the text that it is, and never as less", () => {
    // The title is text for whoever shows it. It is not made harmless by
    // taking something out of it, which would make it another title: it
    // is harmless because it is shown as text.
    const card = cardOf(
      url,
      page(
        '<meta property="og:title" content="&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;b&gt;more&lt;/b&gt;"><meta property="og:description" content="&#60;img src=x onerror=alert(1)&#62;">',
      ),
    );
    expect(card).toEqual({
      url,
      title: "<script>alert(1)</script> & <b>more</b>",
      description: "<img src=x onerror=alert(1)>",
    });
  });

  it("does not take what is written in a script, a style or a comment for the page's own", () => {
    expect(
      cardOf(
        url,
        page(
          '<script>var t = "<title>From a script</title>";</script><!-- <meta property="og:title" content="From a comment"> --><style>/* <title>From a style</title> */</style><title>The real one</title>',
        ),
      ),
    ).toEqual({ url, title: "The real one", description: "" });
  });

  it("takes out what is no text: control characters, and what turns a text around", () => {
    // A null, a bell, an override of the direction and an isolate.
    const noText = [0x0, 0x7, 0x202e, 0x2066].map((code) =>
      String.fromCodePoint(code),
    );
    const card = cardOf(
      url,
      page(
        `<title>A${noText[0]}B${noText[2]}title${noText[3]} ${noText[1]}here</title>`,
      ),
    );
    expect(card?.title).toBe("ABtitle here");
  });

  it("cuts a long title and a long description, between two characters", () => {
    const card = cardOf(
      url,
      page(
        `<title>${"😀".repeat(500)}</title><meta name="description" content="${"d".repeat(2000)}">`,
      ),
    );
    // An emoji is two code units: a hundred of them fit into 200, and
    // none is cut in half.
    expect(card?.title).toBe("😀".repeat(100));
    expect(card?.description).toBe("d".repeat(500));
  });

  it("reads a tag whose value has a bracket in it, and gives up on one that does not end", () => {
    expect(
      cardOf(url, page('<meta property="og:title" content="a > b">'))?.title,
    ).toBe("a > b");
    // A quote that is never closed takes no later tag with it for good:
    // the tag is given up after a bounded length.
    expect(
      cardOf(
        url,
        `<meta property="og:title" content="never closed ${"x".repeat(5000)}<title>After</title>`,
      )?.title,
    ).toBe("After");
  });

  it("is done with a page that is made to make it work, in time", () => {
    // Half a megabyte of tags that begin and never end. Looking through
    // them must take time by the length of the page and not by its
    // square, which would be minutes.
    const hostile = '<meta "<!--<script<title'.repeat(20_000);
    const began = performance.now();
    expect(cardOf(url, hostile)).toBeNull();
    expect(performance.now() - began).toBeLessThan(2000);
  });
});

describe("fetchLinkCard", () => {
  it("reads the page of a link and makes a card of it", async () => {
    const { fetch, asked } = web({
      "https://example.com/a": () =>
        html(page('<meta property="og:title" content="A page">')),
    });
    expect(await fetchLinkCard(fetch, "https://example.com/a")).toEqual({
      url: "https://example.com/a",
      title: "A page",
      description: "",
    });
    // It asks once, changes nothing and carries nothing of anybody.
    expect(asked).toHaveLength(1);
    const [request] = asked;
    expect(request?.method).toBe("GET");
    expect(request?.headers.get("Authorization")).toBeNull();
    expect(request?.headers.get("Cookie")).toBeNull();
  });

  it("does not send what stands after # in a link, and keeps the link of the card as it was written", async () => {
    const { fetch, urls } = web({
      "https://example.com/a": () => html(page("<title>A page</title>")),
    });
    const card = await fetchLinkCard(fetch, "https://example.com/a#section");
    expect(urls()).toEqual(["https://example.com/a"]);
    expect(card?.url).toBe("https://example.com/a#section");
  });

  it.each([
    // Not HTTPS.
    "http://example.com/a",
    // No name of a public host.
    "https://localhost/a",
    "https://127.0.0.1/a",
    "https://[::1]/a",
    "https://192.168.1.1/a",
    "https://printer.local/a",
    "https://intranet.corp/a",
    "https://169.254.169.254/latest/meta-data",
    // A port, and credentials.
    "https://example.com:8443/a",
    "https://user:secret@example.com/a",
    "ftp://example.com/a",
    "not a link",
  ])("asks nothing for %s", async (link) => {
    const { fetch, asked } = web({});
    expect(await fetchLinkCard(fetch, link)).toBeNull();
    expect(asked).toEqual([]);
  });

  it("follows a page that sends it on to another public address", async () => {
    const { fetch, urls } = web({
      "https://short.example/x": () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://example.com/a" },
        }),
      "https://example.com/a": () => html(page("<title>The target</title>")),
    });
    const card = await fetchLinkCard(fetch, "https://short.example/x");
    expect(card).toEqual({
      // The card is of the link that the post has.
      url: "https://short.example/x",
      title: "The target",
      description: "",
    });
    expect(urls()).toEqual([
      "https://short.example/x",
      "https://example.com/a",
    ]);
  });

  it.each([
    "http://example.com/a",
    "https://127.0.0.1/admin",
    "https://localhost/admin",
    "https://10.0.0.1/",
    "https://service.internal/secret",
    "https://example.com:8080/a",
    "file:///etc/passwd",
  ])("does not follow a page that sends it on to %s", async (location) => {
    const { fetch, urls } = web({
      "https://hostile.example/": () =>
        new Response(null, { status: 301, headers: { Location: location } }),
    });
    expect(await fetchLinkCard(fetch, "https://hostile.example/")).toBeNull();
    // The address that it was sent to was never asked.
    expect(urls()).toEqual(["https://hostile.example/"]);
  });

  it("gives up on pages that send it round and round", async () => {
    const { fetch, asked } = web({
      "https://loop.example/": () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://loop.example/" },
        }),
    });
    expect(await fetchLinkCard(fetch, "https://loop.example/")).toBeNull();
    // The first request and as many more as it follows.
    expect(asked).toHaveLength(1 + cardLimits.hops);
  });

  it("reads the beginning of a huge page and leaves the rest unread", async () => {
    let sent = 0;
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    const { fetch } = web({
      "https://huge.example/": () =>
        html(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(page("<title>Huge</title>")),
              );
            },
            // A body without an end: it gives for as long as it is asked.
            pull(controller) {
              sent += chunk.byteLength;
              controller.enqueue(chunk);
            },
          }) as unknown as string,
          // A length that is a lie, and far more than is read.
          { "Content-Length": String(10 * 1024 * 1024 * 1024) },
        ),
    });
    const card = await fetchLinkCard(fetch, "https://huge.example/");
    expect(card?.title).toBe("Huge");
    // What was asked of the body is about what is read of a page, and
    // not what the body would have given.
    expect(sent).toBeLessThan(cardLimits.maxBytes + 4 * chunk.byteLength);
  });

  it("gives up on a page whose body takes too long", async () => {
    const { fetch } = web({
      "https://slow.example/": (request) =>
        html(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("<title>Slow"));
              // Nothing more comes. A real body is ended by the signal
              // of its request, as this one is.
              request.signal.addEventListener("abort", () =>
                controller.error(request.signal.reason),
              );
            },
          }) as unknown as string,
        ),
    });
    const began = Date.now();
    expect(
      await fetchLinkCard(fetch, "https://slow.example/", {
        ...cardLimits,
        timeoutMs: 50,
      }),
    ).toBeNull();
    expect(Date.now() - began).toBeLessThan(2000);
  });

  it("gives up on a host that does not answer in time", async () => {
    const fetch: Fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        );
      });
    expect(
      await fetchLinkCard(fetch, "https://silent.example/", {
        ...cardLimits,
        timeoutMs: 50,
      }),
    ).toBeNull();
  });

  it.each([
    ["a file of another type", "application/pdf"],
    ["JSON", "application/json"],
    ["plain text", "text/plain; charset=utf-8"],
    ["a page in another encoding", "text/html; charset=windows-1252"],
    ["no type at all", ""],
  ])("makes no card of %s, whatever its body says", async (_name, type) => {
    const { fetch } = web({
      "https://example.com/a": () =>
        new Response(page("<title>Looks like a page</title>"), {
          headers: type ? { "Content-Type": type } : {},
        }),
    });
    // A `Response` of a string names a type by itself: taken away for
    // the case without one.
    const untyped: Fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (type) return response;
      const headers = new Headers(response.headers);
      headers.delete("Content-Type");
      return new Response(response.body, { headers });
    };
    expect(await fetchLinkCard(untyped, "https://example.com/a")).toBeNull();
  });

  it.each([404, 403, 500])(
    "makes no card of an answer with the status %i",
    async (status) => {
      const { fetch } = web({
        "https://example.com/a": () =>
          new Response(page("<title>An error page</title>"), {
            status,
            headers: { "Content-Type": "text/html" },
          }),
      });
      expect(await fetchLinkCard(fetch, "https://example.com/a")).toBeNull();
    },
  );

  it("has no card for a host that is not there", async () => {
    const { fetch } = web({});
    expect(await fetchLinkCard(fetch, "https://nowhere.example/")).toBeNull();
  });

  it("passes on what is no failure of a network, as every request of an adapter does", async () => {
    const bug = new Error("A bug behind fetch");
    const fetch: Fetch = async () => {
      throw bug;
    };
    await expect(fetchLinkCard(fetch, "https://example.com/")).rejects.toBe(
      bug,
    );
  });

  it("reads the pages of the simulated web, also one that has moved", async () => {
    const { fetch } = createWebSimulator();
    expect(await fetchLinkCard(fetch, "https://example.test/")).toEqual({
      url: "https://example.test/",
      title: "The example page",
      description:
        "A page of the simulated web of a sandbox, for the links of a post to lead to.",
    });
    expect(
      (await fetchLinkCard(fetch, "https://example.test/moved"))?.title,
    ).toBe("The first post");
    expect(
      await fetchLinkCard(fetch, "https://example.test/file.pdf"),
    ).toBeNull();
    expect(
      await fetchLinkCard(fetch, "https://example.test/nothing"),
    ).toBeNull();
    // What the page writes as markup arrives as the text of it.
    expect(
      (await fetchLinkCard(fetch, "https://example.test/markup"))?.title,
    ).toBe('<b>Bold</b> claims & <script>alert("card")</script>');
  });
});
