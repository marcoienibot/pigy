import type { LinkCard } from "@pigy/core";
import { describe, expect, it } from "vitest";
import {
  cardsAtOnce,
  cardsDeadlineMs,
  type Deadline,
  maxCardsPerDelivery,
  readCards,
} from "../src/publish/cards.ts";
import { expectErrors } from "./helpers.ts";

/**
 * The reading of the pages of a post's links, which the step `cards` of
 * the publishing workflow is made of: it must never fail and never take
 * longer than its own time, because the workflow catches nothing around
 * the step.
 */

const cardOf = (link: string): LinkCard => ({
  url: link,
  title: `The page at ${link}`,
  description: "",
});

/** A deadline that the test lets pass, and that says what was asked of it. */
function deadlineOfTest() {
  let pass = () => {};
  const asked: number[] = [];
  let cleared = false;
  const deadline: Deadline = (milliseconds) => {
    asked.push(milliseconds);
    return {
      passed: new Promise<void>((resolve) => {
        pass = resolve;
      }),
      clear: () => {
        cleared = true;
      },
    };
  };
  return { deadline, asked, pass: () => pass(), cleared: () => cleared };
}

describe("readCards", () => {
  it("is over when its time is up, with the cards that it has read by then", async () => {
    const { deadline, asked, pass, cleared } = deadlineOfTest();
    let late: (card: LinkCard) => void = () => {};
    const reading = readCards(
      ["https://quick.example/", null, "https://hangs.example/"],
      (link) =>
        link === "https://quick.example/"
          ? Promise.resolve(cardOf(link))
          : // A page that nothing ends: not its own limits either.
            new Promise<LinkCard>((resolve) => {
              late = resolve;
            }),
      deadline,
    );
    // Until the time is up, the reading waits for the page: the test
    // would otherwise pass for a reading that waits for nothing.
    let over = false;
    void reading.then(() => {
      over = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(over).toBe(false);
    expect(asked).toEqual([cardsDeadlineMs]);

    pass();
    const cards = await reading;
    expect(cards).toEqual([cardOf("https://quick.example/"), null, null]);
    expect(cleared()).toBe(true);
    // A page that answers afterwards changes nothing of what was handed
    // out: the workflow has stored it by then.
    late(cardOf("https://hangs.example/"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cards[2]).toBeNull();
  });

  it("takes no further link once its time is up", async () => {
    const { deadline, pass } = deadlineOfTest();
    const taken: string[] = [];
    const answers: (() => void)[] = [];
    const links = Array.from(
      { length: cardsAtOnce + 1 },
      (_, index) => `https://example.test/${index}`,
    );
    const reading = readCards(
      links,
      (link) => {
        taken.push(link);
        return new Promise((resolve) => {
          answers.push(() => resolve(null));
        });
      },
      deadline,
    );
    pass();
    await reading;
    // The pages that were open answer now. Nobody goes on to the link
    // that was left, which nobody would wait for.
    for (const answer of answers) answer();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(taken).toEqual(links.slice(0, cardsAtOnce));
  });

  it("does not fail for what the reading of a page throws, and gives its timer up when it is done", async () => {
    const errors = expectErrors();
    const { deadline, cleared } = deadlineOfTest();
    const cards = await readCards(
      ["https://broken.example/", "https://fine.example/"],
      async (link) => {
        // No failure of a page, which is an answer of null, but one of
        // pigy's own.
        if (link === "https://broken.example/") throw new RangeError("A bug");
        return cardOf(link);
      },
      deadline,
    );
    expect(cards).toEqual([null, cardOf("https://fine.example/")]);
    expect(errors).toHaveBeenCalledWith(
      "The card of a link was not read",
      expect.anything(),
    );
    expect(cleared()).toBe(true);
  });

  it("reads for the first links of a long thread and for no more", async () => {
    const { deadline } = deadlineOfTest();
    const links = Array.from(
      { length: maxCardsPerDelivery + 2 },
      (_, index) => `https://example.test/${index}`,
    );
    const cards = await readCards(
      links,
      async (link) => cardOf(link),
      deadline,
    );
    expect(cards).toEqual([
      ...links.slice(0, maxCardsPerDelivery).map(cardOf),
      null,
      null,
    ]);
  });
});
