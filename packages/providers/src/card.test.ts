import type { Fetch } from "@pigy/core";
import { createWebSimulator } from "@pigy/simulators/web";
import { describe, expect, it } from "vitest";
import { cardLimits, cardOf, fetchLinkCard, readPage } from "./card.ts";
import { decodeEntities } from "./html.ts";

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
function web(
  pages: Record<
    string,
    // The signal is the one that the request was made with. The one of
    // `request` follows it only for as long as the runtime keeps what
    // ties the two together, which it does not promise.
    (request: Request, signal: AbortSignal | undefined) => Response
  >,
) {
  const asked: Request[] = [];
  const fetch: Fetch = async (input, init) => {
    const request = new Request(input, init);
    asked.push(request);
    const answer = pages[request.url];
    // What a `fetch` does for a host that is not there.
    if (!answer) throw new TypeError(`No such host: ${request.url}`);
    return answer(request, init?.signal ?? undefined);
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

  it("ends a script where its tag closes, and not at a word that begins like it", () => {
    // "</scripture>" closes no script: the name of a tag ends at
    // whitespace, "/" or ">". What follows it is still the script's.
    expect(
      cardOf(
        url,
        page(
          '<script>const x="</scripture><title>Example</title>";</script><title>Real page</title>',
        ),
      )?.title,
    ).toBe("Real page");
    // The same for a style and for the title itself.
    expect(
      cardOf(
        url,
        page(
          "<style>/* </styles><title>From a style</title> */</style><title>Real </titles> page</title>",
        ),
      )?.title,
    ).toBe("Real </titles> page");
    // And a tag that closes a script may have whitespace in it.
    expect(
      cardOf(url, page("<script>1</script\n><title>After</title>"))?.title,
    ).toBe("After");
  });

  it("takes nothing for a tag that stands within the quotes of another", () => {
    expect(
      cardOf(
        url,
        page(
          '<link rel="x" title="<title>Fake</title>"><title>Real page</title>',
        ),
      )?.title,
    ).toBe("Real page");
    expect(
      cardOf(
        url,
        page(
          `<base data-x='<meta property="og:title" content="Fake">'><title>Real page</title>`,
        ),
      )?.title,
    ).toBe("Real page");
    // Also in the tag of the script itself, and in one that closes.
    expect(
      cardOf(
        url,
        page(
          '<script data-x="</script><title>Fake</title>">1</script><title>Real page</title>',
        ),
      )?.title,
    ).toBe("Real page");
    // A quote opens a value only after "=": the apostrophe of a value
    // without quotes takes nothing with it.
    expect(
      cardOf(url, page("<link title=it's><title>Real page</title>"))?.title,
    ).toBe("Real page");
    // And a tag whose name only begins like one that is known is passed
    // over like any other.
    expect(
      cardOf(
        url,
        page('<metadata content="<title>Fake</title>"><title>Real</title>'),
      )?.title,
    ).toBe("Real");
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

  it("takes a title by where it stands in the page, whatever its letters do in lower case", () => {
    // "İ" is one code unit, and two in lower case: a place that was
    // found in a lowered copy of the page is one further on in the page,
    // and the title came out with the "<" of its end.
    expect(cardOf(url, page("<TITLE>İstanbul travel</TITLE>"))?.title).toBe(
      "İstanbul travel",
    );
    expect(
      cardOf(
        url,
        page(
          "<!-- İİİİ --><SCRIPT>İİ</SCRIPT><Style>İ</sTyle><META NAME=Description CONTENT='İyi'><title>İİİ</title>",
        ),
      ),
    ).toEqual({ url, title: "İİİ", description: "İyi" });
  });

  it("takes the title of the head, and none that a picture in the body has", () => {
    const picture = "<svg><title>A circle</title><circle r=1 /></svg>";
    expect(
      cardOf(
        url,
        `<html><head><meta name="description" content="About"></head><body>${picture}</body></html>`,
      ),
      // The host heads the card: the page names no title.
    ).toEqual({ url, title: "example.com", description: "About" });
    // Also where the page does not say where its head ends.
    expect(cardOf(url, `<p>Text</p>${picture}`)).toBeNull();
    // A title of the page that stands after the picture's is no title
    // of the head either: the head was over.
    expect(cardOf(url, `<body>${picture}<title>Late</title>`)).toBeNull();
    expect(
      cardOf(url, `<head><title>The page</title></head><body>${picture}`)
        ?.title,
    ).toBe("The page");
  });

  it("goes on to the next that says something where a tag is there and empty", () => {
    expect(
      cardOf(
        url,
        page('<meta property="og:title" content=""><title>Plain</title>'),
      )?.title,
    ).toBe("Plain");
  });

  it("reads attributes with and without a value, quoted and not", () => {
    expect(
      cardOf(
        url,
        page(
          "<meta data-x itemscope property = og:title content = 'One' /><meta hidden name=\"description\" content=Two>",
        ),
      ),
    ).toEqual({ url, title: "One", description: "Two" });
  });

  it("has no card for a page that names another encoding than UTF-8 for itself", () => {
    // The page was read as UTF-8, so its letters are not what it wrote.
    for (const tag of [
      '<meta charset="windows-1252">',
      "<META CHARSET=Shift_JIS>",
      '<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">',
    ]) {
      expect(cardOf(url, page(`${tag}<title>Caf�</title>`))).toBeNull();
    }
    for (const tag of [
      '<meta charset="utf-8">',
      "<meta charset=UTF8>",
      '<meta http-equiv="content-type" content="text/html; charset=UTF-8">',
      // No word on the encoding at all.
      '<meta http-equiv="refresh" content="5">',
    ]) {
      expect(cardOf(url, page(`${tag}<title>Café</title>`))?.title).toBe(
        "Café",
      );
    }
    // The answer that carried the page is the one to go by, as for a
    // browser: where it said UTF-8, the tag is wrong.
    expect(
      cardOf(url, page('<meta charset="latin1"><title>Café</title>'), {
        utf8Declared: true,
      })?.title,
    ).toBe("Café");
  });

  it("takes out the mark that turns Arabic letters around", () => {
    expect(cardOf(url, page("<title>A؜B</title>"))?.title).toBe("AB");
  });
});

describe("readPage: the work that a page makes", () => {
  const kilobytes256 = 256 * 1024;
  /** `unit` over and over, up to `length` characters. */
  const filled = (unit: string, length: number) =>
    unit.repeat(Math.ceil(length / unit.length)).slice(0, length);

  // Pages that are made to make pigy work. The first three took seconds
  // when each block set off a search of the rest of the page for the next
  // block of every kind, and when a pattern tried every place of a run of
  // letters as the beginning of an attribute. Their comments and styles
  // are closed: one that is not ends the reading at once.
  const hostile: [name: string, unit: string][] = [
    ["closed comments", "<!---->"],
    ["closed styles", "<style></style>"],
    ["closed scripts", "<script></script>"],
    ["tags with a long name and no value", `<meta ${"a".repeat(4000)}>`],
    ["tags with a long name before a value", `<meta ${"a".repeat(4000)}=>`],
    ["tags whose quote never closes", '<meta "'],
    ["titles that never close", "<title>"],
    ["titles that close", "<title></title>"],
    ["brackets", "<"],
    ["tags that mean nothing here", '<a href="x">'],
    ["tags whose quote never closes, of any name", '<a b="'],
    ["scripts that close at a longer word", "<script></scripture>"],
    ["tags that begin and never end", '<meta "<!--<script<title'],
    ["references that never end", "<title>&#1&#x&amp</title>"],
  ];

  it.each(hostile)(
    "looks at each character of a page of %s a few times at most",
    (_name, unit) => {
      // Counted, not timed: a count is the same on a machine that is
      // busy. Each character is looked at once, and thrice in a tag
      // whose attributes are read.
      for (const length of [kilobytes256 / 4, kilobytes256]) {
        const { work } = readPage(filled(unit, length));
        expect(work).toBeLessThanOrEqual(3 * length);
      }
    },
  );

  it.each(hostile)(
    "makes a card of a page of %s, or none, in the time that its length takes",
    (_name, unit) => {
      // The count above is the scan's own word. This is the clock's,
      // for what the count leaves out, such as the cutting of a title:
      // four times the page may take four times as long, and took
      // sixteen times as long when the work grew with the square.
      const timeOf = (html: string) => {
        let best = Number.POSITIVE_INFINITY;
        for (let run = 0; run < 3; run++) {
          const began = performance.now();
          cardOf("https://example.com/", html);
          best = Math.min(best, performance.now() - began);
        }
        // A reading that is over in no time is not measured: a part of
        // a millisecond is the clock's noise.
        return Math.max(best, 0.5);
      };
      const small = timeOf(filled(unit, kilobytes256 / 4));
      const whole = timeOf(filled(unit, kilobytes256));
      expect(whole / small).toBeLessThan(10);
      // And in itself: a few milliseconds, where a tag with a long name
      // took a second and a half of a pattern that began anew at each
      // of its letters. That grew with the tag and not with the page,
      // so the ratio did not show it.
      expect(whole).toBeLessThan(700);
    },
  );

  it("reads no more of a page than it reads of an answer, and no more tags than a page has", () => {
    const long = `${" ".repeat(kilobytes256)}<title>Beyond</title>`;
    expect(readPage(long).title).toBeUndefined();
    // Every "<" is a tag to look at: after twenty thousand the page is
    // not what this is for.
    const many = `${"<p>".repeat(20_001)}<title>After</title>`;
    expect(readPage(many).title).toBeUndefined();
    expect(readPage(`${"<p>".repeat(1000)}<title>After</title>`).title).toBe(
      "After",
    );
  });
});

describe("decodeEntities", () => {
  it.each([
    // Half of a surrogate pair is no character, and no text to send.
    ["&#xD800;", "�"],
    ["&#xDFFF;", "�"],
    ["&#55357;", "�"],
    ["&#0;", "�"],
    ["&#x0;", "�"],
    // Beyond Unicode, and too long to be a number.
    ["&#x110000;", "�"],
    [`&#${"9".repeat(400)};`, "�"],
    // What is meant by a number of windows-1252.
    ["&#150;", "–"],
    ["&#x80;", "€"],
    // A pair that is written as one number is its character.
    ["&#x1F600;", "😀"],
    ["&#233; &amp; &lt;b&gt;", "é & <b>"],
  ])("resolves %s", (written, text) => {
    expect(decodeEntities(written)).toBe(text);
    // No half of a surrogate pair is left: what encodes as it is.
    expect(new TextDecoder().decode(new TextEncoder().encode(text))).toBe(
      decodeEntities(written),
    );
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
      "https://slow.example/": (_request, signal) =>
        html(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("<title>Slow"));
              // Nothing more comes. A real body is ended by the signal
              // of its request, as this one is.
              signal?.addEventListener("abort", () =>
                controller.error(signal.reason),
              );
            },
          }) as unknown as string,
        ),
    });
    const began = Date.now();
    expect(
      await fetchLinkCard(fetch, "https://slow.example/", {
        limits: { ...cardLimits, timeoutMs: 50 },
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
        limits: { ...cardLimits, timeoutMs: 50 },
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

  it.each([
    ["an error page", 404, "text/html"],
    ["a file of another type", 200, "application/pdf"],
    ["a page in another encoding", 200, "text/html; charset=koi8-r"],
    ["an answer that sends it on", 302, "text/html"],
  ])("reads nothing of the body of %s", async (_name, status, type) => {
    let asked = 0;
    let cancelled = false;
    const { fetch } = web({
      "https://example.com/a": () =>
        new Response(
          new ReadableStream<Uint8Array>({
            // A body that gives for as long as it is asked, and never
            // ends: reading it would take the whole time of the request.
            pull(controller) {
              asked++;
              controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
            },
            cancel() {
              cancelled = true;
            },
          }),
          {
            status,
            headers: {
              "Content-Type": type,
              // Nowhere that it follows: the way ends with this answer.
              ...(status === 302 && { Location: "http://example.com/" }),
            },
          },
        ),
    });
    const began = Date.now();
    expect(await fetchLinkCard(fetch, "https://example.com/a")).toBeNull();
    // Given up at once, and not when the time of the request was over.
    expect(Date.now() - began).toBeLessThan(cardLimits.timeoutMs / 2);
    expect(cancelled).toBe(true);
    // A stream fills its buffer before anybody reads: that much is asked
    // of it, and nothing more.
    expect(asked).toBeLessThanOrEqual(2);
  });

  it("has no card for a page that names another encoding for itself where its answer names none", async () => {
    const body = page('<meta charset="windows-1252"><title>Caf\ufffd</title>');
    const { fetch } = web({
      "https://example.com/untold": () =>
        new Response(body, { headers: { "Content-Type": "text/html" } }),
      "https://example.com/told": () => html(body),
    });
    expect(await fetchLinkCard(fetch, "https://example.com/untold")).toBeNull();
    // The answer said UTF-8, and the answer is what counts.
    expect(
      (await fetchLinkCard(fetch, "https://example.com/told"))?.title,
    ).toBe("Caf\ufffd");
  });

  it("asks no host of pigy's own, at first or where a page sends it on", async () => {
    const { fetch, urls } = web({
      "https://pigy.example/": () => html(page("<title>pigy</title>")),
      "https://short.example/x": () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://pigy.example/" },
        }),
    });
    const ownHosts = ["pigy.example"];
    expect(
      await fetchLinkCard(fetch, "https://pigy.example/", { ownHosts }),
    ).toBeNull();
    expect(
      await fetchLinkCard(fetch, "https://short.example/x", { ownHosts }),
    ).toBeNull();
    expect(urls()).toEqual(["https://short.example/x"]);
    // The same page is read by a pigy that it is not a page of.
    expect((await fetchLinkCard(fetch, "https://short.example/x"))?.title).toBe(
      "pigy",
    );
  });

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
