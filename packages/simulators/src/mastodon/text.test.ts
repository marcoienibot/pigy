import { describe, expect, it } from "vitest";
import {
  countableLength,
  findEntities,
  findLinks,
  type Mentioned,
  renderContent as renderContentOf,
} from "./text.ts";

const grace: Mentioned = {
  id: "7",
  username: "Grace",
  acct: "Grace@other.example",
  url: "https://other.example/@Grace",
};

/** The one account that the mentions of these tests find. */
const accountOf = (username: string, domain: string | undefined) =>
  username.toLowerCase() === "grace" && domain === "other.example"
    ? grace
    : undefined;

const renderContent = (text: string) =>
  renderContentOf(text, "mastodon.example", accountOf);

const count = (text: string) => countableLength(text, 23);
const links = (text: string) =>
  findLinks(text).map(({ start, end }) => text.slice(start, end));

describe("findLinks", () => {
  it("finds what begins with http:// or https://", () => {
    expect(links("See https://example.com/a and http://example.org.")).toEqual([
      "https://example.com/a",
      "http://example.org",
    ]);
  });

  it("takes the port, the path, the query and the fragment along", () => {
    expect(links("https://example.com:8080/a/b?c=d&e=f#g")).toEqual([
      "https://example.com:8080/a/b?c=d&e=f#g",
    ]);
    expect(links("https://example.com?q=1")).toEqual([
      "https://example.com?q=1",
    ]);
    expect(links("https://example.com/")).toEqual(["https://example.com/"]);
  });

  it("leaves out the punctuation that follows a link", () => {
    expect(links("https://example.com/a.")).toEqual(["https://example.com/a"]);
    expect(links("https://example.com/a, b")).toEqual([
      "https://example.com/a",
    ]);
    expect(links("https://example.com/a?b=c!")).toEqual([
      "https://example.com/a?b=c",
    ]);
    expect(links("Is it https://example.com/a?")).toEqual([
      "https://example.com/a",
    ]);
  });

  it("takes parentheses in pairs only", () => {
    expect(links("https://en.wikipedia.org/wiki/Rust_(language)")).toEqual([
      "https://en.wikipedia.org/wiki/Rust_(language)",
    ]);
    expect(links("(see https://example.com/a)")).toEqual([
      "https://example.com/a",
    ]);
    expect(links("https://example.com/a_(b_(c)_d)_e")).toEqual([
      "https://example.com/a_(b_(c)_d)_e",
    ]);
    // An empty pair is not part of a link.
    expect(links("https://example.com/a()")).toEqual(["https://example.com/a"]);
  });

  it("needs a host with a top-level domain", () => {
    expect(links("https://localhost/a")).toEqual([]);
    expect(links("https://example.c/a")).toEqual([]);
    expect(links("https://例え.jp/a")).toEqual(["https://例え.jp/a"]);
    expect(links("https://xn--r8jz45g.xn--zckzah")).toEqual([
      "https://xn--r8jz45g.xn--zckzah",
    ]);
  });

  it("ends the host where the top-level domain ends", () => {
    // What follows is text, not part of the name.
    expect(links("https://example.com日本語")).toEqual(["https://example.com"]);
    expect(links("https://example.com.日本")).toEqual(["https://example.com"]);
    // A top-level domain is not followed by a letter, a digit, "@", "+"
    // or "-": this is no link at all.
    expect(links("https://example.com-x")).toEqual([]);
    expect(links("https://example.com@x")).toEqual([]);
  });

  it("does not find a link inside a word, a mention or a hashtag", () => {
    expect(links("abchttps://example.com")).toEqual([]);
    expect(links("@https://example.com")).toEqual([]);
    expect(links("#https://example.com")).toEqual([]);
    // Text of another script is no obstacle.
    expect(links("日本語https://example.com")).toEqual(["https://example.com"]);
  });

  it("knows no other protocol and no bare domain", () => {
    expect(links("ftp://example.com example.com www.example.com")).toEqual([]);
  });
});

describe("countableLength", () => {
  it("counts a link as what the instance reserves for one", () => {
    expect(count(`https://example.com/${"a".repeat(100)}`)).toBe(23);
    expect(count("http://a.io")).toBe(23);
    expect(countableLength("a https://example.com/long/path b", 5)).toBe(
      "a ".length + 5 + " b".length,
    );
  });

  it("counts a mention without its domain", () => {
    expect(count("@ada@mastodon.example")).toBe("@ada".length);
    expect(count("cc @ada@mastodon.example, @bob")).toBe(
      "cc @ada, @bob".length,
    );
  });

  it("counts a mention with a domain of more than 253 characters in full", () => {
    // From the code: such a text is no mention to Mastodon.
    expect(count(`@ada@${"m".repeat(253)}`)).toBe("@ada".length);
    expect(count(`@ada@${"m".repeat(254)}`)).toBe("@ada@".length + 254);
    // Characters, not code units: each of these letters takes two.
    expect(count(`@ada@${"\u{1D41A}".repeat(253)}`)).toBe("@ada".length);
    expect(count(`@ada@${"\u{1D41A}".repeat(254)}`)).toBe("@ada@".length + 254);
  });

  it("counts an address that only looks like a mention as it is", () => {
    expect(count("ada@mastodon.example")).toBe(20);
    expect(count("@ada@mastodon.example@x")).toBe(23);
    expect(count("https://example.com/@ada@mastodon.example")).toBe(23);
  });

  it("counts what a reader sees as one character once", () => {
    expect(count("😀")).toBe(1);
    expect(count("👨‍👩‍👧‍👦")).toBe(1);
    expect(count("🇮🇹🇮🇹")).toBe(2);
  });
});

describe("renderContent", () => {
  it("makes a paragraph of the text and escapes it", () => {
    expect(renderContent("1 < 2 & 3 > 2")).toBe(
      "<p>1 &lt; 2 &amp; 3 &gt; 2</p>",
    );
  });

  it("parts paragraphs at blank lines and breaks lines elsewhere", () => {
    expect(renderContent("a\nb\n\n\nc")).toBe("<p>a<br />b</p><p>c</p>");
  });

  it("hides the protocol of a link and what is beyond 30 characters", () => {
    expect(renderContent("https://www.example.com/a")).toBe(
      '<p><a href="https://www.example.com/a" target="_blank" rel="nofollow noopener" translate="no"><span class="invisible">https://www.</span><span class="">example.com/a</span><span class="invisible"></span></a></p>',
    );
    const long = `https://example.com/${"a".repeat(30)}`;
    expect(renderContent(long)).toContain(
      `<span class="ellipsis">example.com/${"a".repeat(18)}</span><span class="invisible">${"a".repeat(12)}</span>`,
    );
  });
});

describe("findEntities", () => {
  const found = (text: string) =>
    findEntities(text, accountOf).entities.map(
      ({ kind, start, end }) => `${kind} ${text.slice(start, end)}`,
    );

  it.each([
    ["A #tag here", ["#tag"]],
    [
      "#café #日本語 #tag_2 #2fast ＃wide",
      ["#café", "#日本語", "#tag_2", "#2fast", "＃wide"],
    ],
    ["#tag. (#other), #third!", ["#tag", "#other", "#third"]],
    // A middle dot joins two words of a tag, inside it and not at its end.
    ["#a·b and #c·", ["#a·b", "#c"]],
  ])("finds the hashtags of %j", (text, tags) => {
    expect(found(text)).toEqual(tags.map((tag) => `hashtag ${tag}`));
  });

  it.each(["#1", "#2024", "# tag", "word#tag", "a=#b", "x/#y", "(a)#b"])(
    "finds no hashtag in %j",
    (text) => {
      expect(found(text)).toEqual([]);
    },
  );

  it("takes a mention only of an account that it finds", () => {
    const text = "@grace@other.example and @nobody@other.example and @grace";
    expect(findEntities(text, accountOf)).toEqual({
      entities: [{ kind: "mention", start: 0, end: 20, target: "7" }],
      mentions: [grace],
      tags: [],
    });
  });

  it("lets the one that starts first stay where two overlap", () => {
    // The tag and the mention are in the address of the link.
    expect(found("https://example.com/@grace@other.example#top #real")).toEqual(
      ["link https://example.com/@grace@other.example#top", "hashtag #real"],
    );
  });

  it("lists an account and a tag once, however often they are named", () => {
    const { mentions, tags } = findEntities(
      "#a @grace@other.example #b @Grace@other.example #a",
      accountOf,
    );
    expect(mentions).toEqual([grace]);
    expect(tags).toEqual(["a", "b"]);
  });
});

describe("renderContent, of mentions and hashtags", () => {
  it("links a mention and shows it without its domain", () => {
    expect(renderContent("Hi @grace@other.example!")).toBe(
      '<p>Hi <span class="h-card" translate="no"><a href="https://other.example/@Grace" class="u-url mention">@<span>Grace</span></a></span>!</p>',
    );
  });

  it("leaves a mention of nobody as the text it is", () => {
    expect(renderContent("Hi @nobody")).toBe("<p>Hi @nobody</p>");
  });

  it("links a hashtag to its page on the instance, in lower case", () => {
    expect(renderContent("#Tag")).toBe(
      '<p><a href="https://mastodon.example/tags/tag" class="mention hashtag" rel="tag">#<span>Tag</span></a></p>',
    );
  });
});
