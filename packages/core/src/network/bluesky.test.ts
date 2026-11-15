import { describe, expect, it } from "vitest";
import {
  blueskyMaxBytes,
  blueskyMaxCharacters,
  countBlueskyCharacters,
  utf8Length,
} from "./bluesky.ts";
import { type Limits, validateContent } from "./limits.ts";

const limits: Limits = {
  network: "bluesky",
  maxCharacters: blueskyMaxCharacters,
  maxBytes: blueskyMaxBytes,
};

// A family of four: seven code points, 25 bytes, one character to a person.
const family = "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}";

describe("countBlueskyCharacters", () => {
  it("counts what a person sees as one character as one", () => {
    expect(countBlueskyCharacters("abc")).toBe(3);
    expect(countBlueskyCharacters(family)).toBe(1);
    // A letter with an accent that is written as two code points.
    expect(countBlueskyCharacters("é")).toBe(1);
  });

  it("counts a link, a mention and whitespace in full", () => {
    // Unlike Mastodon, which counts every link as 23 and a mention without
    // its domain, and drops the whitespace around a text.
    const text = " https://example.com/a/rather/long/path @ada.bsky.social ";
    expect(countBlueskyCharacters(text)).toBe(text.length);
  });
});

describe("utf8Length", () => {
  it("counts the bytes, not the characters", () => {
    expect(utf8Length("abc")).toBe(3);
    expect(utf8Length("é")).toBe(2);
    expect(utf8Length(family)).toBe(25);
  });
});

describe("validateContent for Bluesky", () => {
  it("takes 300 characters and reports 301", () => {
    expect(
      validateContent(limits, { parts: [{ text: "a".repeat(300) }] }),
    ).toEqual([]);
    expect(
      validateContent(limits, { parts: [{ text: "a".repeat(301) }] }),
    ).toMatchObject([
      { part: 0, code: "too_long", characters: 301, maxCharacters: 300 },
    ]);
  });

  it("reports a text that is short enough and takes too many bytes", () => {
    // 120 characters, 3000 bytes: exactly what fits.
    const fits = family.repeat(120);
    expect(utf8Length(fits)).toBe(3000);
    expect(validateContent(limits, { parts: [{ text: fits }] })).toEqual([]);
    // One letter more is 121 characters, far below 300, and 3001 bytes.
    expect(validateContent(limits, { parts: [{ text: `${fits}a` }] })).toEqual([
      {
        part: 0,
        code: "too_many_bytes",
        bytes: 3001,
        maxBytes: 3000,
        message:
          "The post takes 3001 bytes, which is more than the 3000 that Bluesky allows. Emoji and letters with accents take several each.",
      },
    ]);
  });

  it("reports a text that is too long once, as too long", () => {
    // 301 families are over both limits. One thing to fix is one report.
    expect(
      validateContent(limits, { parts: [{ text: family.repeat(301) }] }),
    ).toMatchObject([{ code: "too_long" }]);
  });
});
