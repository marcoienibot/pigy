import { describe, expect, it } from "vitest";
import { findLinks } from "./links.ts";

/** The links of `text` as they are written, and the address of each. */
const found = (text: string, bare = true) =>
  findLinks(text, { bare }).map(({ start, end, url }) => [
    text.slice(start, end),
    url,
  ]);

/** A link that is written with its scheme leads to what is written. */
const schemed = (...links: string[]) => links.map((link) => [link, link]);

describe("findLinks, with a scheme", () => {
  it.each([
    ["See https://example.com for more", ["https://example.com"]],
    ["http://example.com/a/b?c=d&e=f#g", ["http://example.com/a/b?c=d&e=f#g"]],
    ["HTTPS://Example.COM/Path", ["HTTPS://Example.COM/Path"]],
    ["https://example.com:8080/x", ["https://example.com:8080/x"]],
    // Two links, with one character between them.
    [
      "https://a.example https://b.example",
      ["https://a.example", "https://b.example"],
    ],
    ["line one\nhttps://example.com\nline three", ["https://example.com"]],
  ])("finds the links of %j", (text, links) => {
    expect(found(text)).toEqual(schemed(...links));
  });

  it.each([
    // The punctuation of the sentence is not the link's.
    ["Read https://example.com/a.", "https://example.com/a"],
    ["Read https://example.com/a, then", "https://example.com/a"],
    ["Is it https://example.com/a?", "https://example.com/a"],
    ["Wow https://example.com/a!", "https://example.com/a"],
    ["See https://example.com.", "https://example.com"],
    ["“https://example.com/a”", "https://example.com/a”"],
    ["Quoted 'https://example.com/a'", "https://example.com/a"],
    ["https://example.com/a; and", "https://example.com/a"],
    // A slash at the end is the link's.
    ["https://example.com/a/.", "https://example.com/a/"],
  ])("leaves the punctuation after a link out of it: %j", (text, link) => {
    expect(found(text)).toEqual(schemed(link));
  });

  it.each([
    // A pair of brackets within a link belongs to it.
    [
      "https://en.wikipedia.example/wiki/Rust_(programming_language)",
      "https://en.wikipedia.example/wiki/Rust_(programming_language)",
    ],
    // The brackets around a link do not.
    ["(https://example.com/a)", "https://example.com/a"],
    ["(see https://example.com/a_(b))", "https://example.com/a_(b)"],
    // One level deep.
    ["https://example.com/a(b(c)d)", "https://example.com/a(b(c)d)"],
  ])("takes brackets only in pairs: %j", (text, link) => {
    expect(found(text)).toEqual(schemed(link));
  });

  it.each([
    // A host in another script, and one in Punycode.
    ["https://bücher.example/buch", "https://bücher.example/buch"],
    ["https://例え.jp/パス", "https://例え.jp/パス"],
    ["https://xn--bcher-kva.example/", "https://xn--bcher-kva.example/"],
    ["https://example.xn--p1ai/x", "https://example.xn--p1ai/x"],
  ])("takes an international domain: %j", (text, link) => {
    expect(found(text)).toEqual(schemed(link));
  });

  it.each([
    // No host, or none with a top-level domain.
    "https://",
    "https://localhost/x",
    "https://example.c",
    // Not in the middle of a word, a mention or a hashtag.
    "xhttps://example.com",
    "@https://example.com",
    "#https://example.com",
    // Another scheme.
    "ftp://example.com/file",
    "mailto:ada@example.com",
  ])("finds no link in %j", (text) => {
    expect(found(text, false)).toEqual([]);
  });
});

describe("findLinks, without a scheme", () => {
  it.each([
    ["Go to example.com now", "example.com"],
    ["example.com/a/b?c=d", "example.com/a/b?c=d"],
    ["(example.org/page)", "example.org/page"],
    ["sub.domain.example.co.uk/x.", "sub.domain.example.co.uk/x"],
    ["See example.com.", "example.com"],
    ["my-site.dev", "my-site.dev"],
    // The longer top-level domain, not the shorter one that it begins
    // with: ".community", not ".co".
    ["our.community/rules", "our.community/rules"],
  ])("finds the link of %j", (text, link) => {
    expect(found(text)).toEqual([[link, `https://${link}`]]);
  });

  it.each([
    // No top-level domain of the list.
    "file.txt",
    "version 1.2.3",
    "e.g. this",
    "example.nosuchtld",
    // Only in lower case, as Bluesky's app has it: a sentence that lacks
    // the space after its full stop is no address.
    "It ended.It began",
    "Example.com",
    // Not within a word, an address of mail or a mention.
    "ada@example.com",
    "@ada.example.com",
    "x/example.com",
    // What goes on after the top-level domain is another name.
    "example.comx",
    "example.com-x",
  ])("finds no link in %j", (text) => {
    expect(found(text)).toEqual([]);
  });

  it("leaves them out where it is not asked for them", () => {
    // Mastodon links no address without its scheme.
    expect(found("example.com and https://example.org", false)).toEqual(
      schemed("https://example.org"),
    );
  });

  it("takes a name within a link with a scheme for part of that link", () => {
    expect(found("https://a.example/ (b.com)")).toEqual([
      ["https://a.example/", "https://a.example/"],
      ["b.com", "https://b.com"],
    ]);
    expect(found("https://a.example/x_(b.com)")).toEqual(
      schemed("https://a.example/x_(b.com)"),
    );
  });

  it("lists the links in their order, whichever way they are written", () => {
    expect(found("b.com then https://a.example then c.org")).toEqual([
      ["b.com", "https://b.com"],
      ["https://a.example", "https://a.example"],
      ["c.org", "https://c.org"],
    ]);
  });
});
