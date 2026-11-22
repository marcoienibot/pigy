import { describe, expect, it } from "vitest";
import { ApiError } from "./api.ts";
import { Answers, unaskedNote, whyUnasked } from "./preview.ts";

describe("Answers", () => {
  it("asks a question once, however many ask it and however often", async () => {
    const answers = new Answers<string>();
    let asked = 0;
    let answer: (card: string) => void = () => {};
    const ask = () => {
      asked++;
      return new Promise<string>((resolve) => {
        answer = resolve;
      });
    };
    // Thirty parts of a thread that lead to the same page, all at once.
    const waiting = Array.from({ length: 30 }, () =>
      answers.ask("https://example.test/", ask),
    );
    expect(asked).toBe(1);
    expect(answers.kept("https://example.test/")).toBeUndefined();
    answer("The page");
    expect(await Promise.all(waiting)).toEqual(waiting.map(() => "The page"));
    // And later, when a part with the link is added: the answer is kept.
    expect(await answers.ask("https://example.test/", ask)).toBe("The page");
    expect(answers.kept("https://example.test/")).toEqual({
      answer: "The page",
    });
    expect(asked).toBe(1);
    // Another question is another request.
    void answers.ask("https://other.example/", ask);
    expect(asked).toBe(2);
  });

  it("keeps an answer that says that there is nothing, and no question that failed", async () => {
    const answers = new Answers<string | null>();
    expect(await answers.ask("no card", async () => null)).toBeNull();
    // Null is an answer: the page has no card, and is not asked again.
    expect(answers.kept("no card")).toEqual({ answer: null });

    let asked = 0;
    const failing = async () => {
      asked++;
      throw new TypeError("Failed to fetch");
    };
    await expect(answers.ask("offline", failing)).rejects.toThrow(TypeError);
    expect(answers.kept("offline")).toBeUndefined();
    // Asked again the next time: the connection may be back.
    await expect(answers.ask("offline", failing)).rejects.toThrow(TypeError);
    expect(asked).toBe(2);
    expect(await answers.ask("offline", async () => "Back")).toBe("Back");
  });
});

describe("whyUnasked", () => {
  it("tells a question that got no answer from one that the server refused", () => {
    // What `fetch` fails with on a device without a connection.
    expect(whyUnasked(new TypeError("Failed to fetch"))).toBe("offline");
    expect(whyUnasked(new ApiError(429, "Too many"))).toBe("limit");
    expect(whyUnasked(new ApiError(500, "Broken"))).toBe("failed");
    // None of them says that the page could not be read: nobody tried.
    for (const note of Object.values(unaskedNote)) {
      expect(note).not.toMatch(/could not read/);
    }
  });
});
