import { defaultFilter } from "cmdk";

/** What the palette calls the command that goes to the screen `label`. */
export const goTo = (label: string) => `Go to ${label}`;

/**
 * How well a command of the palette matches what was typed, for the
 * order in which the palette lists the commands: higher is better, and 0
 * leaves the command out. It is the order of the palette library, with
 * one rule before it: a screen whose name is typed in full comes first.
 * Somebody who types "queue" and presses Enter means the Queue screen,
 * and not a command that has the word in it, such as the one that pauses
 * the queue, which the library ranks before it.
 */
export function paletteFilter(
  value: string,
  search: string,
  keywords?: string[],
): number {
  const typed = search.trim().toLowerCase();
  if (typed !== "" && value.toLowerCase() === goTo(typed).toLowerCase()) {
    // More than the library gives anything: its scores end at 1.
    return 2;
  }
  return defaultFilter(value, search, keywords);
}
