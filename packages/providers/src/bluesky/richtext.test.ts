import { maxLookedUpMentions as maxMentions } from "@pigy/core";
import { describe, expect, it } from "vitest";
import { embedOf, facetsOf, mentionedHandles } from "./richtext.ts";

/** The bytes of `text` that a facet names, read as text. */
const marked = (
  text: string,
  { byteStart, byteEnd }: { byteStart: number; byteEnd: number },
) =>
  new TextDecoder().decode(
    new TextEncoder().encode(text).slice(byteStart, byteEnd),
  );

describe("facetsOf", () => {
  it("names each link, tag and mention by the bytes that it takes", () => {
    // Letters of two, three and four bytes before each of them.
    const text = "über 日本 😀 https://example.com/ü #日本 @ada.bsky.test";
    const facets = facetsOf(text, new Map([["ada.bsky.test", "did:plc:ada"]]));
    expect(
      facets.map(({ index, features }) => [marked(text, index), features[0]]),
    ).toEqual([
      [
        "https://example.com/ü",
        {
          $type: "app.bsky.richtext.facet#link",
          uri: "https://example.com/ü",
        },
      ],
      ["#日本", { $type: "app.bsky.richtext.facet#tag", tag: "日本" }],
      [
        "@ada.bsky.test",
        { $type: "app.bsky.richtext.facet#mention", did: "did:plc:ada" },
      ],
    ]);
    // "über " is six bytes, "日本 " seven, the emoji and its space five.
    expect(facets[0]?.index.byteStart).toBe(18);
  });

  it("marks no mention of a handle that is nobody's", () => {
    expect(facetsOf("Hi @nobody.bsky.test", new Map())).toEqual([]);
  });

  it("marks a mention whatever the case it is written in", () => {
    // The handle was looked up in lower case, which is how it is kept.
    const facets = facetsOf(
      "@ADA.bsky.test",
      new Map([["ada.bsky.test", "did:plc:ada"]]),
    );
    expect(facets).toHaveLength(1);
  });
});

describe("mentionedHandles", () => {
  it("lists every handle once, in lower case", () => {
    expect(
      mentionedHandles("@ada.bsky.test @Ada.bsky.test @grace.bsky.test"),
    ).toEqual(["ada.bsky.test", "grace.bsky.test"]);
  });

  it("asks about so many accounts and no more", () => {
    const text = Array.from(
      { length: maxMentions + 5 },
      (_, index) => `@user${index}.bsky.test`,
    ).join(" ");
    expect(mentionedHandles(text)).toHaveLength(maxMentions);
  });
});

describe("embedOf", () => {
  const card = { url: "https://example.com", title: "T", description: "D" };

  it("is the card of the first link of the text, also of one without its scheme", () => {
    expect(embedOf("see example.com", card)).toEqual({
      $type: "app.bsky.embed.external",
      external: { uri: "https://example.com", title: "T", description: "D" },
    });
  });

  it("is nothing without a card, and for a card of another link", () => {
    expect(embedOf("see example.com", undefined)).toBeUndefined();
    expect(embedOf("see example.org and example.com", card)).toBeUndefined();
    expect(embedOf("no link", card)).toBeUndefined();
  });
});
