import { describe, expect, it } from "vitest";
import {
  blueskyHandlesOf,
  cardNote,
  markNotes,
  marksOf,
  previewLinkOf,
  segmentsOf,
} from "./markup.ts";

/** The marks of `text`, each as its kind and how it is written. */
const marked = (...args: Parameters<typeof marksOf>) =>
  marksOf(...args).map(
    ({ kind, start, end, everywhere }) =>
      `${kind} ${args[0].slice(start, end)}${everywhere ? "" : " (not everywhere)"}`,
  );

describe("marksOf", () => {
  it("marks what any network would take, for a text that goes nowhere yet", () => {
    expect(marked("@ada https://example.test/ example.com #tag", [])).toEqual([
      "mention @ada",
      "link https://example.test/",
      "link example.com",
      "hashtag #tag",
    ]);
  });

  it("marks what the one network of the text takes", () => {
    const text = "@ada @ada.bsky.test example.com #one #two";
    expect(marked(text, ["mastodon"])).toEqual([
      "mention @ada",
      // The form of Mastodon takes a name with dots too.
      "mention @ada.bsky.test",
      "hashtag #one",
      "hashtag #two",
    ]);
    expect(marked(text, ["bluesky"])).toEqual([
      "mention @ada.bsky.test",
      "link example.com",
      "hashtag #one",
      "hashtag #two",
    ]);
    expect(marked(text, ["linkedin"])).toEqual([
      "hashtag #one",
      "hashtag #two",
    ]);
    // One tag per post on Threads.
    expect(marked(text, ["threads"])).toEqual([
      "mention @ada",
      "mention @ada.bsky.test",
      "hashtag #one",
    ]);
  });

  it("says of a mark that not every network of the text takes it", () => {
    expect(
      marked("@ada https://example.test/ #one #two", [
        "mastodon",
        "threads",
        "linkedin",
      ]),
    ).toEqual([
      "mention @ada (not everywhere)",
      "link https://example.test/",
      "hashtag #one",
      "hashtag #two (not everywhere)",
    ]);
  });

  it("takes a mention of Bluesky for text once Bluesky is known to have no such account", () => {
    const text = "@ada.bsky.test and @nobody.bsky.test";
    // Until the answer is in, both are taken for accounts.
    expect(marked(text, ["bluesky"])).toHaveLength(2);
    expect(
      marked(text, ["bluesky"], {
        asked: new Set(["ada.bsky.test", "nobody.bsky.test"]),
        found: new Set(["ada.bsky.test"]),
      }),
    ).toEqual(["mention @ada.bsky.test"]);
  });

  it("hands out the address of a link", () => {
    expect(marksOf("see example.com", ["bluesky"])[0]?.url).toBe(
      "https://example.com",
    );
  });
});

describe("segmentsOf", () => {
  it("cuts a text at its marks and leaves nothing of it out", () => {
    const text = "a #b c https://d.example";
    const segments = segmentsOf(text, marksOf(text, []));
    expect(
      segments.map(({ text: part, mark }) => [part, mark?.kind ?? null]),
    ).toEqual([
      ["a ", null],
      ["#b", "hashtag"],
      [" c ", null],
      ["https://d.example", "link"],
    ]);
    expect(segments.map(({ text: part }) => part).join("")).toBe(text);
  });

  it("is the text itself where nothing is marked", () => {
    expect(segmentsOf("plain", [])).toEqual([{ text: "plain", mark: null }]);
    expect(segmentsOf("", [])).toEqual([]);
  });
});

describe("markNotes", () => {
  it("says nothing where every network takes everything", () => {
    expect(
      markNotes("https://example.test/ #tag", ["mastodon", "bluesky"]),
    ).toEqual([]);
    expect(markNotes("plain words", ["linkedin"])).toEqual([]);
  });

  it("says that LinkedIn has no mentions of pigy's, also where LinkedIn is the only network", () => {
    expect(markNotes("Thanks @ada", ["linkedin"])).toEqual([
      "@ada is text on LinkedIn. LinkedIn gives pigy no way to mention a member.",
    ]);
  });

  it("says that Threads takes the first tag alone", () => {
    expect(markNotes("#one #two #three", ["threads"])).toEqual([
      "#two and #three are text on Threads. Threads takes one tag per post: the first.",
    ]);
  });

  it("says that an address without its scheme is a link on Bluesky alone", () => {
    expect(markNotes("see example.com", ["bluesky", "mastodon"])).toEqual([
      "example.com is text on Mastodon. Mastodon links an address only with https:// before it.",
    ]);
  });

  it("says how a mention is written on Bluesky, and which handle is nobody's there", () => {
    expect(markNotes("@ada", ["bluesky"])).toEqual([
      "@ada is text on Bluesky. A mention on Bluesky is the handle of an account, such as @name.bsky.social.",
    ]);
    expect(
      markNotes("@nobody.bsky.test and @Other.bsky.test", ["bluesky"], {
        asked: new Set(["nobody.bsky.test", "other.bsky.test"]),
        found: new Set(),
      }),
    ).toEqual([
      "Bluesky has no account @nobody.bsky.test and @Other.bsky.test: they stay text there.",
    ]);
  });

  it("says nothing of a network that takes a mention in its own way", () => {
    // Mastodon reads "@ada.bsky.test" as a name with dots: marked there
    // too, so there is nothing to say.
    expect(markNotes("@ada.bsky.test", ["bluesky", "mastodon"])).toEqual([]);
  });
});

describe("what the editor asks the server about", () => {
  it("previews the first link that an account of the text takes for one", () => {
    expect(
      previewLinkOf("example.com then https://b.example", ["bluesky"]),
    ).toBe("https://example.com");
    // Mastodon links no address without its scheme.
    expect(
      previewLinkOf("example.com then https://b.example", ["mastodon"]),
    ).toBe("https://b.example");
    expect(previewLinkOf("no link", [])).toBeNull();
  });

  it("asks Bluesky about each handle once, in an order that does not change as the text does", () => {
    expect(
      blueskyHandlesOf("@grace.bsky.test @Ada.bsky.test @ada.bsky.test @ada"),
    ).toEqual(["ada.bsky.test", "grace.bsky.test"]);
  });

  it("says who shows the card of a link", () => {
    expect(cardNote(["bluesky", "mastodon", "linkedin"])).toBe(
      "Bluesky and LinkedIn show this with the post. Mastodon reads the page itself, and may show it another way.",
    );
    expect(cardNote(["threads"])).toBe(
      "Threads reads the page itself, and may show it another way.",
    );
  });
});
