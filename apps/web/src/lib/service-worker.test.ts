import { afterEach, expect, it, vi } from "vitest";
import { mayTakeOver, pressedPath } from "./service-worker.ts";

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

// Where a message of the service worker leads a window: to a path of the
// app, and nowhere else. The address in it is read back from a
// notification, and a message can come from anything that controls the
// page.

it.each([
  ["a screen", "/inbox"],
  ["a screen with what it is to show", "/sent?post=1&inWorkspace=a-b"],
  ["the first screen", "/"],
])("leads to %s of the app", (_what, url) => {
  expect(pressedPath({ type: "navigate", url })).toBe(url);
});

it.each([
  ["an address at another site", "https://elsewhere.example/"],
  ["an address that leaves the site", "//elsewhere.example/"],
  // A browser reads a backslash as a slash, and drops a tab.
  ["the same with a backslash", "/\\elsewhere.example/"],
  ["the same with a tab in it", "/\t/elsewhere.example/"],
  ["a script", "javascript:alert(1)"],
  ["what is no address", 7],
  ["no address at all", undefined],
])("leads nowhere for %s", (_what, url) => {
  expect(pressedPath({ type: "navigate", url })).toBeNull();
});

it("leads nowhere for a message that is not about a notification", () => {
  expect(pressedPath({ type: "activate", url: "/inbox" })).toBeNull();
  expect(pressedPath("navigate")).toBeNull();
  expect(pressedPath(null)).toBeNull();
});
