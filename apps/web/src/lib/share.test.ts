import { maxPartTextLength } from "@pigy/core";
import { expect, it } from "vitest";
import { sharedFrom, sharedText } from "./share.ts";

it.each([
  [
    "a page that a browser shares, as its title and its address",
    { title: "A fine article", text: "", url: "https://example.com/article" },
    "A fine article\n\nhttps://example.com/article",
  ],
  [
    "a text with the address in it, as many apps share",
    { text: "Look at this https://example.com/a", url: "" },
    "Look at this https://example.com/a",
  ],
  [
    "a text and an address apart",
    { text: "Look at this", url: "https://example.com/a" },
    "Look at this\n\nhttps://example.com/a",
  ],
  [
    "an address that is in the text already, once",
    { text: "Look: https://example.com/a", url: "https://example.com/a" },
    "Look: https://example.com/a",
  ],
  [
    "the title of a page whose address came as the text",
    { title: "A fine article", text: "https://example.com/article" },
    "A fine article\n\nhttps://example.com/article",
  ],
  [
    "a text of the person's without the title that came with it",
    { title: "Shared from Notes", text: "My own words" },
    "My own words",
  ],
  ["a title alone", { title: "Only this" }, "Only this"],
  ["an address alone", { url: "https://example.com/" }, "https://example.com/"],
  ["nothing", {}, ""],
  ["only spaces", { title: " ", text: "\n", url: "  " }, ""],
])("makes a draft of %s", (_what, shared, text) => {
  expect(sharedText(shared)).toBe(text);
});

it("cuts what is longer than a part of a post may be", () => {
  const text = sharedText({ text: "a".repeat(maxPartTextLength + 5) });

  expect(text).toHaveLength(maxPartTextLength);
});

it("reads what was shared from an address, as text whatever it reads like", () => {
  expect(
    sharedFrom({ title: 2026, text: true, url: "https://example.com/", x: 1 }),
  ).toEqual({ title: "2026", text: "true", url: "https://example.com/" });
  // What is no text at all is left out.
  expect(sharedFrom({ title: { a: 1 }, text: null })).toEqual({});
});
