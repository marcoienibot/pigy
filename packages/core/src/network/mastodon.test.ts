import { describe, expect, it } from "vitest";
import { countMastodonCharacters, stripMastodonText } from "./mastodon.ts";

const count = (text: string) => countMastodonCharacters(text, 23);

describe("countMastodonCharacters", () => {
  it("counts plain text by its characters", () => {
    expect(count("Hello, world")).toBe(12);
    expect(count("")).toBe(0);
  });

  it("counts what a reader sees as one character once", () => {
    // Two code units, one code point.
    expect(count("😀")).toBe(1);
    // Seven code points: four people joined into one family.
    expect(count("👨‍👩‍👧‍👦")).toBe(1);
    // A flag is two code points.
    expect(count("🇮🇹")).toBe(1);
    // "e" followed by a combining accent.
    expect(count("e\u0301")).toBe(1);
  });

  it("counts every link as the same number of characters", () => {
    expect(count("https://example.com")).toBe(23);
    expect(
      count(`https://example.com/${"a".repeat(200)}?query=${"b".repeat(50)}`),
    ).toBe(23);
    // Shorter than 23 characters, and still 23.
    expect(count("http://a.io")).toBe(23);
    expect(count("Read https://example.com/a and https://example.org/b")).toBe(
      "Read ".length + 23 + " and ".length + 23,
    );
  });

  it("goes by what the instance reserves for a link", () => {
    expect(countMastodonCharacters("https://example.com/long/path", 10)).toBe(
      10,
    );
  });

  it("leaves the punctuation after a link out of it", () => {
    expect(count("See https://example.com/page.")).toBe("See ".length + 23 + 1);
    expect(count("(https://example.com/page)")).toBe(1 + 23 + 1);
    expect(count("https://example.com/a, https://example.com/b!")).toBe(
      23 + ", ".length + 23 + 1,
    );
  });

  it("keeps a pair of parentheses inside a link", () => {
    expect(
      count("https://en.wikipedia.org/wiki/Rust_(programming_language)"),
    ).toBe(23);
  });

  it("counts a link that follows text of another script", () => {
    // No space is needed before a link, unless what precedes it is an ASCII
    // letter or digit.
    expect(count("日本語https://example.com")).toBe(3 + 23);
  });

  it("counts as written what is not a link", () => {
    // No protocol.
    expect(count("example.com")).toBe(11);
    // Another protocol.
    expect(count("ftp://example.com")).toBe(17);
    // No dot in the host.
    expect(count("https://localhost")).toBe(17);
    // Glued to a word.
    expect(count("abchttps://example.com")).toBe(22);
  });

  it("counts a mention without its domain", () => {
    expect(count("@alice@example.com")).toBe("@alice".length);
    expect(count("Hi @alice@example.com and @bob@social.example!")).toBe(
      "Hi @alice and @bob!".length,
    );
    // A local mention has no domain to leave out.
    expect(count("@alice")).toBe(6);
  });

  it("counts as written what only looks like a mention", () => {
    // An email address: the "@" follows a word.
    expect(count("alice@example.com")).toBe(17);
    // Followed by another "@".
    expect(count("@alice@example.com@more")).toBe(23);
  });

  it("does not count the whitespace around the text", () => {
    // Mastodon removes it before it stores, and counts, the text.
    expect(count("  Hello \n\n")).toBe(5);
    // Inside the text it counts.
    expect(count("a\n\nb")).toBe(4);
  });
});

describe("stripMastodonText", () => {
  it("removes less than trim does", () => {
    // Ruby's strip leaves a no-break space where it is.
    expect(stripMastodonText(" \u00a0a\u00a0\t")).toBe("\u00a0a\u00a0");
  });
});
