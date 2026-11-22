import { expect, it } from "vitest";
import { goTo, paletteFilter } from "./palette.ts";

/**
 * The commands of the palette that have "queue" in them, as the palette
 * gives them to its filter: what a command is called, and the words that
 * it is also found by.
 */
const commands: [value: string, keywords: string[]][] = [
  ["Add to queue", ["slot", "later"]],
  ["Share next", ["queue", "first", "slot"]],
  ["Pause the queue", ["hold", "stop", "resume", "continue"]],
  [goTo("Queue"), []],
  [goTo("Sent"), []],
];

/** The commands that the palette lists for `search`, the best first. */
const listed = (search: string) =>
  commands
    .map(([value, keywords]) => ({
      value,
      score: paletteFilter(value, search, keywords),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ value }) => value);

it("lists a screen first when its name is typed in full, before the commands that have the word", () => {
  // Enter takes the first: "queue" goes to the Queue screen, and does
  // not pause the queue.
  expect(listed("queue")[0]).toBe("Go to Queue");
  expect(listed(" Queue ")[0]).toBe("Go to Queue");
  // The commands with the word are listed all the same.
  expect(listed("queue")).toEqual(
    expect.arrayContaining(["Pause the queue", "Add to queue", "Share next"]),
  );
});

it("leaves every other search to the order of the palette", () => {
  expect(listed("pause")).toEqual(["Pause the queue"]);
  // A part of a name is no name.
  expect(listed("que")).not.toEqual([]);
  expect(paletteFilter("Go to Queue", "que", [])).toBeLessThanOrEqual(1);
  expect(listed("nothing like it")).toEqual([]);
});
