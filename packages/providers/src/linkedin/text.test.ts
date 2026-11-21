import { describe, expect, it } from "vitest";
import { escapeLittleText } from "./text.ts";

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
