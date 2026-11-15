/**
 * What the publishing workflow does about a step that a network asks to
 * have tried again: how long it waits, and when it gives up.
 */

/** How often a step is run at most. */
export const maxTries = 6;

/**
 * The shortest wait before a step is run again, in seconds. A step is run
 * again only when the run before it is over, and an adapter waits half a
 * minute for an answer: this is longer.
 */
export const shortestWaitSeconds = 60;

/**
 * The longest wait that the workflow goes along with, in seconds. A network
 * that names a later time is not waited for: the delivery fails, and the
 * person tries again when they see fit.
 */
export const longestWaitSeconds = 60 * 60;

/**
 * How long to wait before a step that failed with `retry` is run again, in
 * seconds, or null to give up. `named` is how far away the time is that the
 * network named, in seconds, or null if it named none. `tries` is how
 * often the step has been run.
 *
 * Where the network names a time, that is when the step is run again, and
 * not before the shortest wait is over. Where it names none, the waits
 * double from the shortest one: 1, 2, 4, 8 and 16 minutes, so a network
 * that stays out of reach is given up on after half an hour.
 */
export function retryWaitSeconds(
  named: number | null,
  tries: number,
): number | null {
  if (tries >= maxTries) return null;
  if (named === null) return shortestWaitSeconds * 2 ** (tries - 1);
  if (named > longestWaitSeconds) return null;
  return Math.max(named, shortestWaitSeconds);
}
