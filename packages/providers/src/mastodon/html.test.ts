import { describe, expect, it } from "vitest";
import { htmlToText } from "./html.ts";

describe("htmlToText", () => {
  it("reads paragraphs and line breaks as blank lines and line breaks", () => {
    expect(htmlToText("<p>One<br />two<br>three</p><p>Four</p>")).toBe(
      "One\ntwo\nthree\n\nFour",
    );
  });

  it("gives a link back whole", () => {
    // From entities/Status of Mastodon's documentation: the parts of an
    // address that are not shown are still there.
    expect(
      htmlToText(
        '<p>See <a href="https://example.com/a/long/path" rel="nofollow noopener noreferrer" target="_blank"><span class="invisible">https://</span><span class="ellipsis">example.com/a/long</span><span class="invisible">/path</span></a>.</p>',
      ),
    ).toBe("See https://example.com/a/long/path.");
  });

  it("reads a mention and a hashtag as their text", () => {
    expect(
      htmlToText(
        '<p><span class="h-card" translate="no"><a href="https://mastodon.example/@ada" class="u-url mention">@<span>ada</span></a></span> likes <a href="https://mastodon.example/tags/math" class="mention hashtag" rel="tag">#<span>math</span></a></p>',
      ),
    ).toBe("@ada likes #math");
  });

  it("turns the entities back into characters", () => {
    expect(
      htmlToText(
        "<p>1 &lt; 2 &amp;&amp; &quot;a&quot; &gt; &#39;b&#39; &#x1F600;</p>",
      ),
    ).toBe("1 < 2 && \"a\" > 'b' \u{1F600}");
  });

  it("leaves alone what only looks like an entity", () => {
    // Decoded once: "&amp;lt;" is the text "&lt;", not "<".
    expect(htmlToText("<p>&amp;lt; &nosuch; &amp;#99999999;</p>")).toBe(
      "&lt; &nosuch; &#99999999;",
    );
  });

  it("reads a reference to a character that there is not as a browser does", () => {
    // U+FFFD, as the HTML standard has it. Mastodon writes no such
    // reference: it escapes the "&" of one that somebody typed.
    expect(htmlToText("<p>&#99999999; &#xD83D;</p>")).toBe("\ufffd \ufffd");
  });
});
