import { describe, expect, it } from "vitest";
import { ApiError } from "./api.ts";
import {
  Answers,
  askAgainAfter,
  askAgainAfterMs,
  askAgainAtMostMs,
  unaskedNote,
  whyUnasked,
} from "./preview.ts";

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
      until: null,
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
    expect(answers.kept("no card")).toEqual({ answer: null, until: null });

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

  /** Answers whose "no", null, lasts a minute, by a clock of the test's. */
  const withClock = () => {
    const clock = { now: 1_000_000 };
    const answers = new Answers<string | null>({
      lasts: (answer) => (answer === null ? 60_000 : null),
      now: () => clock.now,
    });
    return { answers, clock };
  };

  it("asks again about an answer that says no once its time is over, and never about one that says yes", async () => {
    const { answers, clock } = withClock();
    let asked = 0;
    const none = async () => {
      asked++;
      return null;
    };
    await answers.ask("gone", none);
    await answers.ask("there", async () => "A card");
    expect(answers.kept("gone")).toEqual({ answer: null, until: 1_060_000 });
    clock.now += 59_999;
    expect(answers.due("gone")).toBe(false);
    await answers.ask("gone", none);
    expect(asked).toBe(1);

    clock.now += 1;
    expect(answers.due("gone")).toBe(true);
    // Still handed out, until the question is answered again: nothing
    // on screen changes for an answer that stays the same.
    expect(answers.kept("gone")?.answer).toBeNull();
    // The page is there by now.
    expect(await answers.ask("gone", async () => "Up again")).toBe("Up again");
    expect(answers.kept("gone")).toEqual({ answer: "Up again", until: null });

    // A yes has no end, however long the editor is open.
    clock.now += 24 * 60 * 60 * 1000;
    expect(answers.due("there")).toBe(false);
  });

  it("does not hand out an answer whose time is over in place of a question that got none", async () => {
    const { answers, clock } = withClock();
    await answers.ask("gone", async () => null);
    clock.now += 60_000;
    await expect(
      answers.ask("gone", async () => {
        throw new TypeError("Failed to fetch");
      }),
    ).rejects.toThrow(TypeError);
    // What is said now is that nobody answered, not that there is no
    // card.
    expect(answers.kept("gone")).toBeUndefined();
  });

  it("forgets an answer that says no when what it is about has left the texts, and keeps one that says yes", async () => {
    const { answers } = withClock();
    await answers.ask("gone", async () => null);
    await answers.ask("there", async () => "A card");
    await answers.ask("stays", async () => null);
    // The texts hold one of the three now.
    answers.present(["stays"]);
    expect(answers.kept("gone")).toBeUndefined();
    expect(answers.due("gone")).toBe(true);
    expect(answers.kept("stays")?.answer).toBeNull();
    expect(answers.kept("there")?.answer).toBe("A card");
  });

  it("asks about each of several once, whichever lists it is in, also while a question is on its way", async () => {
    const answers = new Answers<boolean>();
    const questions: string[][] = [];
    const replies: (() => void)[] = [];
    const ask = (keys: string[]) => {
      questions.push(keys);
      return new Promise<(key: string) => boolean>((resolve) => {
        replies.push(() => resolve((key) => key !== "alan"));
      });
    };
    // Two parts that are opened together and mention Ada both.
    const first = answers.askAll(["ada", "grace"], ask);
    const second = answers.askAll(["ada", "alan"], ask);
    // Ada is asked about by the first alone, though no answer has come.
    expect(questions).toEqual([["ada", "grace"], ["alan"]]);
    // The second waits for the answer of the first too: Ada's is in it.
    let done = false;
    void second.then(() => {
      done = true;
    });
    replies[1]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(done).toBe(false);
    replies[0]?.();
    await Promise.all([first, second]);
    expect(
      ["ada", "grace", "alan"].map((key) => answers.kept(key)?.answer),
    ).toEqual([true, true, false]);
    // And a third part, later: nothing is left to ask.
    await answers.askAll(["grace", "alan"], ask);
    expect(questions).toHaveLength(2);
  });

  it("fails for everybody who waited for a question about several, and keeps nothing of it", async () => {
    const answers = new Answers<boolean>();
    const failing = async () => {
      throw new TypeError("Failed to fetch");
    };
    await expect(answers.askAll(["ada", "grace"], failing)).rejects.toThrow(
      TypeError,
    );
    expect(answers.kept("ada")).toBeUndefined();
    // Asked again the next time.
    await answers.askAll(["ada"], async () => () => true);
    expect(answers.kept("ada")?.answer).toBe(true);
  });
});

describe("askAgainAfter", () => {
  it("waits a minute after the first refusal and longer after each, up to a bound", () => {
    expect(askAgainAfter(1)).toBe(askAgainAfterMs);
    expect(askAgainAfter(2)).toBe(2 * askAgainAfterMs);
    expect(askAgainAfter(3)).toBe(4 * askAgainAfterMs);
    // It never stops asking, and never waits longer than this.
    expect(askAgainAfter(50)).toBe(askAgainAtMostMs);
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
