import type { LinkCard } from "@pigy/core";
import { type LogContext, log } from "../log.ts";

/**
 * What the step `cards` of the publishing workflow does: it reads the
 * pages of the links of a post, several at once, and is over within a
 * time of its own, with what it has read by then.
 *
 * It never fails. That is what lets the workflow call the step without
 * catching anything around it: what is thrown out of the step is then
 * never a card that was not read, and always the platform's, which the
 * workflow throws on. See `withCards` in workflow.ts.
 */

/**
 * How many pages a delivery reads for the cards of its links at most, and
 * how many of them at once. Each has its seconds and its bytes,
 * `cardLimits` of @pigy/providers, and what a page can make pigy work
 * has a bound there too. So the reading is over within
 * `maxCardsPerDelivery / cardsAtOnce` times the seconds of one page,
 * which is ten seconds, whatever the pages are. A thread with more links
 * than this goes out with cards for the first of them.
 */
export const maxCardsPerDelivery = 8;
export const cardsAtOnce = 4;

/**
 * How long the reading takes at the longest, in milliseconds, whatever
 * stands behind a page: after that the links that are not read go
 * without a card. Longer than the pages take by their own limits, so it
 * ends only a reading in which something hangs that those do not end,
 * and half of what the platform gives the step, `cardStep` of
 * workflow.ts, which is then never what ends it.
 */
export const cardsDeadlineMs = 15_000;

/**
 * A time that passes: `passed` resolves after so many milliseconds, and
 * `clear` gives the timer up for whoever is done before.
 */
export type Deadline = (milliseconds: number) => {
  passed: Promise<void>;
  clear: () => void;
};

/** A deadline by the timer of the runtime. */
export const deadlineByTimer: Deadline = (milliseconds) => {
  let clear = () => {};
  const passed = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    clear = () => clearTimeout(timer);
  });
  return { passed, clear: () => clear() };
};

/**
 * The cards of `links`, in their order, read with `read`: null for a
 * link that is null, for a page without a card, for a link beyond
 * `maxCardsPerDelivery` and for one that was not read by the time that
 * `deadline` gives, `cardsDeadlineMs`.
 *
 * `read` answers null for a page that cannot be read, as `fetchLinkCard`
 * does. What it throws is no failure of a page but one of pigy's, such
 * as a simulated world that refuses: it is logged, and the link has no
 * card. That is this function's own call, and so its own to catch.
 */
export async function readCards(
  links: readonly (string | null)[],
  read: (link: string) => Promise<LinkCard | null>,
  deadline: Deadline,
  /** What a line of the log says of the delivery that the cards are for. */
  where: LogContext = {},
): Promise<(LinkCard | null)[]> {
  const cards: (LinkCard | null)[] = links.map(() => null);
  // The first of them, in the order of the parts.
  const wanted = links
    .flatMap((link, index) => (link === null ? [] : [{ link, index }]))
    .slice(0, maxCardsPerDelivery);
  // Several at once, each taking the next link that nobody has taken: a
  // thread does not wait for its pages one after the other, and no more
  // than `cardsAtOnce` requests are open.
  let next = 0;
  let over = false;
  const reader = async () => {
    while (!over) {
      const taken = wanted[next++];
      if (taken === undefined) return;
      try {
        cards[taken.index] = await read(taken.link);
      } catch (error) {
        // Not the link: an address is somebody's text.
        log.error("delivery", "The card of a link was not read", where, error);
      }
    }
  };
  const { passed, clear } = deadline(cardsDeadlineMs);
  try {
    await Promise.race([
      Promise.all(
        Array.from({ length: Math.min(cardsAtOnce, wanted.length) }, reader),
      ),
      passed,
    ]);
  } finally {
    over = true;
    clear();
  }
  // As they are now: a page that answers after the time is up changes
  // nothing of what is handed out.
  return [...cards];
}
