import { maxPartTextLength } from "@pigy/core";
import { describe, expect, it } from "vitest";
import {
  sharedFrom,
  sharedImages,
  sharedText,
  sharesSomething,
} from "./share.ts";

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

/** The query of the address that a share of `shared` opens. */
const queryOf = (shared: Record<string, string>) =>
  `?${new URLSearchParams(shared)}`;

it.each([
  // Each reads like JSON, which is how a router reads a query: as
  // nothing, as a list, as an object, as a number that a float cannot
  // hold, and as a text without its quotation marks.
  ["null"],
  ["[1,2]"],
  ['{"a":1}'],
  ["9007199254740993"],
  ['"quoted"'],
  ["true"],
  ["2026"],
])("reads %s from an address as the text that it is", (text) => {
  expect(sharedFrom(queryOf({ text }))).toEqual({ text });
  expect(sharedFrom(queryOf({ title: text, text: "", url: text }))).toEqual({
    title: text,
    text: "",
    url: text,
  });
  expect(sharedText(sharedFrom(queryOf({ text })))).toBe(text);
});

it("reads what was shared from an address with or without its question mark, and nothing else of it", () => {
  const query =
    "title=A+fine+article&url=https%3A%2F%2Fexample.com%2F%3Fa%3D1%26b%3D2&x=1";

  for (const written of [query, `?${query}`]) {
    expect(sharedFrom(written)).toEqual({
      title: "A fine article",
      url: "https://example.com/?a=1&b=2",
    });
  }
  expect(sharedFrom("")).toEqual({});
});

it("reads the name of the files that the service worker keeps for a share, and a share of files alone shares something", () => {
  const shared = sharedFrom("files=0193-share");
  expect(shared).toEqual({ files: "0193-share" });
  expect(sharedText(shared)).toBe("");
  expect(sharesSomething(shared)).toBe(true);
  expect(sharesSomething(sharedFrom("files="))).toBe(false);
  expect(sharesSomething(sharedFrom("text=+"))).toBe(false);
});

describe("sharedImages", () => {
  const file = (name: string, text: string) => ({
    name,
    type: "image/png",
    file: new Blob([text]),
  });
  // Reads a file as the editor does: here, by what it holds.
  const read = async (blob: Blob) =>
    (await blob.text()) === "image"
      ? { facts: {} }
      : { refused: "is not a JPEG, PNG, WebP or GIF image" };

  it("shows the files that are images, by their bytes, and says of the others why not", async () => {
    const { images, notes } = await sharedImages(
      {
        id: "share",
        at: 0,
        files: [
          file("photo.png", "image"),
          // A page that says that it is a picture.
          file("page.png", "<html>"),
          file("", "nothing"),
        ],
        left: 2,
      },
      read,
    );
    expect(images.map(({ name, type }) => ({ name, type }))).toEqual([
      { name: "photo.png", type: "image/png" },
    ]);
    expect(notes).toEqual([
      "page.png is not a JPEG, PNG, WebP or GIF image.",
      "A file is not a JPEG, PNG, WebP or GIF image.",
      "2 more files were shared. A post takes 4 images, of 20 MB at most each.",
    ]);
  });

  it("says that the images are gone where the device no longer has them", async () => {
    expect(await sharedImages(undefined, read)).toEqual({
      images: [],
      notes: [
        "The images of this share are no longer on this device. Share them again.",
      ],
    });
  });
});
