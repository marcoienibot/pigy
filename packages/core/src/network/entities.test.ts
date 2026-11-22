import { describe, expect, it } from "vitest";
import { cardLinks, detectEntities, utf8Range } from "./entities.ts";
import { countMastodonCharacters } from "./mastodon.ts";
import type { Network } from "./network.ts";

/** What `network` finds in `text`, each as its kind and how it is written. */
const found = (network: Network | null, text: string) =>
  detectEntities(network, text).map(
    ({ kind, start, end }) => `${kind} ${text.slice(start, end)}`,
  );

const everyNetwork = ["bluesky", "linkedin", "mastodon", "threads"] as const;

describe("detectEntities: hashtags", () => {
  it.each([
    ["A #tag here", ["#tag"]],
    ["#one #two", ["#one", "#two"]],
    // Letters of any script, with their marks, digits and underscores.
    [
      "#café #日本語 #עברית #tag_2 #2fast",
      ["#café", "#日本語", "#עברית", "#tag_2", "#2fast"],
    ],
    // The full-width sign.
    ["＃tag", ["＃tag"]],
    // The punctuation after a tag is not the tag's.
    ["#tag. #other, (#third)", ["#tag", "#other", "#third"]],
    ["#tag-with-dash", ["#tag"]],
  ])("finds the hashtags of %j", (text, tags) => {
    expect(found("mastodon", text)).toEqual(
      tags.map((tag) => `hashtag ${tag}`),
    );
  });

  it.each([
    // No letter in it.
    "#1",
    "#2024",
    "#_",
    "# tag",
    // In the middle of a word, of an address or of a parameter.
    "word#tag",
    "a=#b",
    "&#39;",
  ])("finds no hashtag in %j", (text) => {
    expect(found("mastodon", text)).toEqual([]);
  });

  it("takes no tag that is longer than Bluesky takes one", () => {
    expect(found("bluesky", `#${"a".repeat(64)}`)).toHaveLength(1);
    expect(found("bluesky", `#${"a".repeat(65)}`)).toEqual([]);
  });

  it("hands out the tag without its sign", () => {
    expect(detectEntities("linkedin", "A #Tag")).toEqual([
      { kind: "hashtag", start: 2, end: 6, tag: "Tag" },
    ]);
  });

  it("finds them the same way on every network, but for the one tag of Threads", () => {
    const text = "#one and #two";
    for (const network of ["bluesky", "linkedin", "mastodon"] as const) {
      expect(found(network, text)).toEqual(["hashtag #one", "hashtag #two"]);
    }
    // Threads has one tag per post: the second is text there.
    expect(found("threads", text)).toEqual(["hashtag #one"]);
  });
});

describe("detectEntities: mentions", () => {
  it("reads a mention the way Mastodon writes one", () => {
    expect(
      detectEntities("mastodon", "@ada and @Grace@example.social."),
    ).toEqual([
      { kind: "mention", start: 0, end: 4, name: "ada" },
      { kind: "mention", start: 9, end: 30, name: "Grace@example.social" },
    ]);
  });

  it("reads a mention the way Bluesky writes one: a handle, which is a domain", () => {
    expect(
      detectEntities("bluesky", "Hi @Ada.bsky.test, and (@grace.example.com)."),
    ).toEqual([
      // A handle is compared in lower case.
      { kind: "mention", start: 3, end: 17, name: "ada.bsky.test" },
      { kind: "mention", start: 24, end: 42, name: "grace.example.com" },
    ]);
  });

  it.each([
    // No handle: a name without a domain mentions nobody on Bluesky.
    "@ada",
    // The form of Mastodon is none of Bluesky's.
    "@ada@example.social",
    "mail@ada.bsky.test",
    // A top-level domain does not begin with a digit.
    "@ada.123",
  ])("finds no mention of Bluesky in %j", (text) => {
    expect(
      found("bluesky", text).filter((entity) => entity.startsWith("mention")),
    ).toEqual([]);
  });

  it("reads a mention the way Threads writes one, without the full stop of the sentence", () => {
    expect(found("threads", "Thanks @ada.sandbox. And @grace_h!")).toEqual([
      "mention @ada.sandbox",
      "mention @grace_h",
    ]);
    expect(found("threads", "mail@example and a/@b")).toEqual([]);
  });

  it("finds none on LinkedIn, where pigy cannot write one", () => {
    expect(found("linkedin", "Thanks @ada and @grace@example.social")).toEqual(
      [],
    );
  });

  it("takes an address of mail for no mention on any network", () => {
    for (const network of everyNetwork) {
      expect(found(network, "write to ada@example.nosuch")).toEqual([]);
    }
  });
});

describe("detectEntities", () => {
  it("lists what it finds in the order of the text", () => {
    expect(found("mastodon", "#a @b https://c.example #d")).toEqual([
      "hashtag #a",
      "mention @b",
      "link https://c.example",
      "hashtag #d",
    ]);
  });

  it("takes what stands within a link for part of the link", () => {
    for (const network of everyNetwork) {
      expect(found(network, "https://example.social/@ada#top")).toEqual([
        "link https://example.social/@ada#top",
      ]);
    }
  });

  it("links an address without a scheme everywhere but on Mastodon", () => {
    const text = "see example.com";
    expect(found("mastodon", text)).toEqual([]);
    for (const network of ["bluesky", "linkedin", "threads"] as const) {
      expect(found(network, text)).toEqual(["link example.com"]);
    }
  });

  it("finds for no network in particular what any of them would", () => {
    expect(
      found(
        null,
        "@ada @grace@example.social @alan.bsky.test example.com #tag",
      ),
    ).toEqual([
      "mention @ada",
      "mention @grace@example.social",
      "mention @alan.bsky.test",
      "link example.com",
      "hashtag #tag",
    ]);
  });

  it("finds as a link and as a mention with a domain what Mastodon's counter counts as one", () => {
    // The counter and the detection go by the same functions. A text of
    // two links and a mention with a domain is counted as the links at 23
    // each and the mention without its domain, which is what this text
    // comes to only if the counter found the same three things.
    const text =
      "https://example.com/a-long-path @ada@example.social http://b.example";
    const entities = detectEntities("mastodon", text);
    expect(entities.map(({ kind }) => kind)).toEqual([
      "link",
      "mention",
      "link",
    ]);
    expect(countMastodonCharacters(text, 23)).toBe(
      23 + 1 + "@ada".length + 1 + 23,
    );
  });
});

describe("utf8Range", () => {
  /** The bytes of `text` that the range of `part` names, read as text. */
  const sliced = (text: string, part: string) => {
    const start = text.indexOf(part);
    const { byteStart, byteEnd } = utf8Range(text, {
      start,
      end: start + part.length,
    });
    return {
      byteStart,
      byteEnd,
      text: new TextDecoder().decode(
        new TextEncoder().encode(text).slice(byteStart, byteEnd),
      ),
    };
  };

  it("is the range itself in a text of ASCII", () => {
    expect(sliced("Go to #tag now", "#tag")).toEqual({
      byteStart: 6,
      byteEnd: 10,
      text: "#tag",
    });
  });

  it("counts an emoji before the range as the four bytes that it takes", () => {
    // Two code units in the string, four bytes in UTF-8.
    expect(sliced("😀 #tag", "#tag")).toEqual({
      byteStart: 5,
      byteEnd: 9,
      text: "#tag",
    });
  });

  it("counts an emoji of several code points, and a combining mark, by their bytes", () => {
    // A family: three people of four bytes, joined by two joiners of three.
    const family = "👨‍👩‍👧";
    expect(
      sliced(`${family} https://example.com`, "https://example.com"),
    ).toEqual({
      byteStart: 19,
      byteEnd: 38,
      text: "https://example.com",
    });
    // "e" with a combining acute accent: one byte and two. Before the
    // tag are "caf", those three and a space: seven bytes.
    const accented = "é";
    expect(sliced(`caf${accented} #caf${accented}`, `#caf${accented}`)).toEqual(
      {
        byteStart: 7,
        byteEnd: 14,
        text: `#caf${accented}`,
      },
    );
  });

  it("counts letters of two and of three bytes", () => {
    expect(sliced("über 日本 @ada.bsky.test", "@ada.bsky.test")).toEqual({
      // "ü" is two bytes, each of "日本" three.
      byteStart: 13,
      byteEnd: 27,
      text: "@ada.bsky.test",
    });
  });
});

describe("cardLinks", () => {
  const content = {
    parts: [
      { text: "No link here" },
      { text: "Two: https://a.example and https://b.example" },
      { text: "example.com" },
    ],
  };

  it("is the first link of each part where each part is a post", () => {
    expect(cardLinks("bluesky", content)).toEqual([
      null,
      "https://a.example",
      "https://example.com",
    ]);
  });

  it("goes by what the network takes for a link", () => {
    // Mastodon links no address without its scheme.
    expect(cardLinks("mastodon", content)).toEqual([
      null,
      "https://a.example",
      null,
    ]);
  });

  it("is the first link of the whole text on LinkedIn, which makes one post of it", () => {
    expect(cardLinks("linkedin", content)).toEqual([
      null,
      "https://a.example",
      null,
    ]);
    expect(
      cardLinks("linkedin", { parts: [{ text: "a.dev" }, { text: "b.dev" }] }),
    ).toEqual(["https://a.dev", null]);
  });
});
