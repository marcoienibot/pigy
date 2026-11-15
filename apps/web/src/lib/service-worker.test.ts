import { afterEach, expect, it, vi } from "vitest";
import { mayTakeOver } from "./service-worker.ts";

// Whether a page that starts lets a version that waits take over, by what
// the browser says when it is asked who holds a Web Lock. The page has no
// screen before that is decided. What it decides when a window does hold
// the lock is tested in a browser, in e2e/tests/update.spec.ts: here are
// the answers that a browser of the tests does not give.

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The browser answers the question about its locks as `query` does. */
function locksAnswer(query: () => Promise<never>): void {
  vi.stubGlobal("navigator", { locks: { query } });
}

it("starts as the version it is when the browser does not say who holds the lock", async () => {
  vi.useFakeTimers();
  // What Chromium does with the question of a page that it renders ahead
  // of time: the answer comes when somebody opens the page, or never.
  locksAnswer(() => new Promise(() => {}));

  const decided = mayTakeOver();
  // However long the page gives the browser: all of it.
  await vi.runAllTimersAsync();

  // Decided, which is what lets the app render, and against the take-over.
  // A page that waited on would be "undecided" here.
  expect(await Promise.race([decided, "undecided"])).toBe(false);
});

it("lets the new version take over when the browser fails to say who holds the lock", async () => {
  vi.useFakeTimers();
  // The failure is logged, which is not what this test is about.
  vi.spyOn(console, "error").mockImplementation(() => {});
  locksAnswer(() => Promise.reject(new DOMException("No", "SecurityError")));

  const decided = mayTakeOver();
  // Not `runAllTimersAsync`: the answer has to be in before the time that
  // the browser is given is up, or this would say nothing about a failure.
  await vi.advanceTimersByTimeAsync(0);

  expect(await Promise.race([decided, "undecided"])).toBe(true);
});
