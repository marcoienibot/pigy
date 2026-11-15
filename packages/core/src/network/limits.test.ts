import { describe, expect, it } from "vitest";
import { type Limits, limitsSchema, validateContent } from "./limits.ts";

const limits: Limits = {
  network: "mastodon",
  maxCharacters: 20,
  charactersPerUrl: 23,
};

describe("validateContent", () => {
  it("finds nothing wrong with text up to the limit", () => {
    expect(
      validateContent(limits, { parts: [{ text: "a".repeat(20) }] }),
    ).toEqual([]);
  });

  it("reports a part that is over the limit, with both numbers", () => {
    expect(
      validateContent(limits, {
        parts: [{ text: "fine" }, { text: "a".repeat(21) }],
      }),
    ).toEqual([
      {
        part: 1,
        code: "too_long",
        characters: 21,
        maxCharacters: 20,
        message: "Part 2 is 21 characters long. The limit is 20.",
      },
    ]);
  });

  it("counts the way the network does, not the way String.length does", () => {
    // 20 emoji are 40 UTF-16 code units and 20 characters to Mastodon.
    expect(
      validateContent(limits, { parts: [{ text: "😀".repeat(20) }] }),
    ).toEqual([]);
    // A link of 30 characters counts as 23, which is over 20.
    expect(
      validateContent(limits, {
        parts: [{ text: "https://example.com/0123456789" }],
      }),
    ).toMatchObject([{ code: "too_long", characters: 23 }]);
  });

  it("reports a part without text", () => {
    expect(
      validateContent(limits, { parts: [{ text: "one" }, { text: " \n " }] }),
    ).toEqual([{ part: 1, code: "empty", message: "Part 2 has no text." }]);
  });

  it("calls a post of one part a post", () => {
    expect(validateContent(limits, { parts: [{ text: "" }] })).toEqual([
      { part: 0, code: "empty", message: "The post has no text." },
    ]);
  });

  it("reports every part that has something wrong", () => {
    const issues = validateContent(limits, {
      parts: [{ text: "" }, { text: "fine" }, { text: "a".repeat(30) }],
    });
    expect(issues.map(({ part, code }) => [part, code])).toEqual([
      [0, "empty"],
      [2, "too_long"],
    ]);
  });
});

describe("limitsSchema", () => {
  it("accepts the limits of a Mastodon instance", () => {
    expect(limitsSchema.parse(limits)).toEqual(limits);
  });

  it("refuses limits that name no network, or carry something unknown", () => {
    const { network: _, ...withoutNetwork } = limits;
    expect(limitsSchema.safeParse(withoutNetwork).success).toBe(false);
    expect(limitsSchema.safeParse({ ...limits, extra: 1 }).success).toBe(false);
    expect(
      limitsSchema.safeParse({ ...limits, maxCharacters: 0 }).success,
    ).toBe(false);
  });
});
