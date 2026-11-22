import * as core from "@pigy/core";
import { describe, expect, it, vi } from "vitest";
import {
  cardNote,
  detected,
  lookedUpHandles,
  markNotes,
  marksOf,
  previewsOf,
  segmentsOf,
} from "./markup.ts";

// The detection of `@pigy/core` itself, watched: how often the editor
// has a text looked through is what one of the tests is about.
vi.mock("@pigy/core", async (original) => {
  const actual = await original<typeof import("@pigy/core")>();
  return { ...actual, detectEntities: vi.fn(actual.detectEntities) };
});

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
    const text = "example.com then https://b.example";
    expect(previewsOf([text], ["bluesky"])).toEqual([
      [{ link: "https://example.com", networks: ["bluesky"] }],
    ]);
    // Mastodon links no address without its scheme.
    expect(previewsOf([text], ["mastodon"])).toEqual([
      [{ link: "https://b.example", networks: ["mastodon"] }],
    ]);
    expect(previewsOf(["no link"], ["mastodon"])).toEqual([[]]);
    // A text that goes nowhere yet: what any network would take.
    expect(previewsOf([text, "no link"], [])).toEqual([
      [{ link: "https://example.com", networks: [] }],
      [],
    ]);
  });

  it("previews for each network the link that the network leads with, and names the network with it", () => {
    // An address without its scheme is a link on Bluesky alone: Bluesky
    // shows the card of the first address, and LinkedIn that of the
    // second. One preview for both said that LinkedIn shows a card which
    // it does not get.
    expect(
      previewsOf(["example.com https://other.com"], ["linkedin", "bluesky"]),
    ).toEqual([
      [
        { link: "https://example.com", networks: ["bluesky"] },
        { link: "https://other.com", networks: ["linkedin"] },
      ],
    ]);
    // Where they lead with the same link, it is one preview.
    expect(
      previewsOf(["https://example.com"], ["mastodon", "bluesky", "linkedin"]),
    ).toEqual([
      [
        {
          link: "https://example.com",
          networks: ["bluesky", "linkedin", "mastodon"],
        },
      ],
    ]);
  });

  it("previews one card for LinkedIn in a thread, with the part that its first link is in", () => {
    // LinkedIn makes one post of the parts, with the card of the first
    // link of them all. Bluesky makes a post of each, with its own.
    expect(
      previewsOf(
        ["No link here", "https://one.example", "https://two.example"],
        ["bluesky", "linkedin"],
      ),
    ).toEqual([
      [],
      [{ link: "https://one.example", networks: ["bluesky", "linkedin"] }],
      [{ link: "https://two.example", networks: ["bluesky"] }],
    ]);
    expect(
      previewsOf(["https://one.example", "https://two.example"], ["linkedin"]),
    ).toEqual([[{ link: "https://one.example", networks: ["linkedin"] }], []]);
  });

  it("asks Bluesky about each handle once, in the order of the text, as a post looks them up", () => {
    expect(
      lookedUpHandles("@grace.bsky.test @Ada.bsky.test @ada.bsky.test @ada"),
    ).toEqual(["grace.bsky.test", "ada.bsky.test"]);
  });

  it("takes a mention beyond the ten that a post looks up for text on Bluesky, and says why", () => {
    const handles = Array.from(
      { length: 12 },
      // The later in the text, the earlier in the alphabet: the ten that
      // are looked up are the first of the text, not of a sorted list.
      (_, index) => `${String.fromCharCode(122 - index)}.bsky.test`,
    );
    const text = handles.map((handle) => `@${handle}`).join(" ");
    expect(lookedUpHandles(text)).toEqual(handles.slice(0, 10));
    // Before any answer is in: the first ten are taken for accounts, and
    // the other two are text whatever is answered.
    expect(marked(text, ["bluesky"])).toEqual(
      handles.slice(0, 10).map((handle) => `mention @${handle}`),
    );
    expect(markNotes(text, ["bluesky"])).toEqual([
      "@p.bsky.test and @o.bsky.test stay text on Bluesky: pigy looks up the first 10 accounts that a part mentions.",
    ]);
    // A handle that is repeated takes the place of no other: the first
    // ten are still the same ten, with one of them marked three times.
    expect(
      marked(`@z.bsky.test @z.bsky.test ${text}`, ["bluesky"]),
    ).toHaveLength(12);
  });

  it("has a text looked through once for each network, however often it is asked about", () => {
    const detect = vi.mocked(core.detectEntities);
    const text = "A text of its own: https://example.test/ @ada #tag";
    const networks = ["bluesky", "linkedin", "mastodon", "threads"] as const;
    detect.mockClear();
    // What the editor does with a part at every key, and twice over.
    for (let render = 0; render < 2; render++) {
      marksOf(text, networks);
      markNotes(text, networks);
      lookedUpHandles(text);
      previewsOf([text], networks);
    }
    // Once for each of the four, and once for no network in particular,
    // which the notes go by.
    expect(detect.mock.calls.map(([network]) => network).sort()).toEqual(
      [null, ...networks].sort(),
    );
    expect(detected("bluesky", text)).toBe(detected("bluesky", text));
  });

  it("makes its marks and its notes in work that grows with the text, and not with its square", () => {
    const unit = "@ada.bsky.test @ada #tag example.com ";
    const networks = ["bluesky", "linkedin", "mastodon", "threads"] as const;
    const timeOf = (text: string) => {
      const began = performance.now();
      marksOf(text, networks);
      markNotes(text, networks);
      return performance.now() - began;
    };
    // The shortest of three runs, the one least disturbed, for both
    // lengths: a single run of the longer text, a quarter of a second of work,
    // is the one that a pause of a busy machine falls into. Each run has
    // a text of its own, because the editor hands out what it has made
    // of a text before, and such a run would measure nothing.
    const best = (repeats: number) =>
      Math.min(
        ...[1, 2, 3].map((run) => timeOf(`${run} ${unit.repeat(repeats)}`)),
      );
    // Four times the text may take four times as long, and took sixteen
    // times as long when every mark was held against every other.
    const small = best(1000);
    expect(best(4000) / small).toBeLessThan(9);
    // Three runs of a quarter of a second, and more on a machine that
    // runs every suite at once: the test has the time for that.
  }, 30_000);

  it("says who shows the card of a link", () => {
    expect(cardNote(["bluesky", "mastodon", "linkedin"])).toBe(
      "Bluesky and LinkedIn show this with the post. Mastodon reads the page itself, and may show it another way.",
    );
    expect(cardNote(["threads"])).toBe(
      "Threads reads the page itself, and may show it another way.",
    );
  });
});
