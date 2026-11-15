/**
 * What code that talks to external services receives as parameters instead of
 * taking it from the environment. Tests and simulations pass their own.
 */

/** Stands in for the global `fetch`. */
export type Fetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Stands in for `new Date()`. */
export type Clock = () => Date;

/**
 * Stands in for `setTimeout`: calls `callback` once, after `delayMs`.
 * Returns how to call that off.
 */
export type Schedule = (callback: () => void, delayMs: number) => () => void;
