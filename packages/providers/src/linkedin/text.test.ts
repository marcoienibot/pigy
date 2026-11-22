import { describe, expect, it } from "vitest";
import { escapeLittleText, littleText } from "./text.ts";

describe("escapeLittleText", () => {
  it("leaves a text without reserved characters as it is", () => {
    const text = "Plain text, with a link: https://example.com/a?b=c&d=e!\n😀";
    expect(escapeLittleText(text)).toBe(text);
  });

  it("writes every reserved character after a backslash", () => {
    // The fifteen characters that the format reserves, each once.
    expect(escapeLittleText("|{}@[]()<>#\\*_~")).toBe(
      "\\|\\{\\}\\@\\[\\]\\(\\)\\<\\>\\#\\\\\\*\\_\\~",
    );
  });

  it("escapes a backslash that is in the text, so that it escapes nothing itself", () => {
    expect(escapeLittleText("a\\(b")).toBe("a\\\\\\(b");
  });
});

describe("littleText", () => {
  it("writes a hashtag as the template of the format", () => {
    expect(littleText("Read this #news today")).toBe(
      "Read this {hashtag|\\#|news} today",
    );
  });

  it("escapes the underscore of a tag, which the format reserves", () => {
    expect(littleText("#big_news")).toBe("{hashtag|\\#|big\\_news}");
  });

  it("writes tags of other scripts, and the full-width sign as it is", () => {
    expect(littleText("#日本語 and ＃wide")).toBe(
      "{hashtag|\\#|日本語} and {hashtag|\\＃|wide}",
    );
  });

  it("escapes a sign that begins no hashtag, as every reserved character", () => {
    // A number is no tag, and neither is a sign in the middle of a word
    // or of an address.
    expect(littleText("#1 a#b https://example.com/#top")).toBe(
      "\\#1 a\\#b https://example.com/\\#top",
    );
  });

  it("leaves a mention as the text that it is, escaped", () => {
    // LinkedIn names a member by an ID that pigy cannot look up.
    expect(littleText("Thanks @ada and @grace@example.social")).toBe(
      "Thanks \\@ada and \\@grace\\@example.social",
    );
  });

  it("escapes what stands between and around the tags", () => {
    expect(littleText("(a) #one [b] #two {c}")).toBe(
      "\\(a\\) {hashtag|\\#|one} \\[b\\] {hashtag|\\#|two} \\{c\\}",
    );
  });

  it("is the text itself where it has neither a tag nor a reserved character", () => {
    const text = "Plain text, with a link: https://example.com/a?b=c&d=e!\n😀";
    expect(littleText(text)).toBe(text);
  });
});
