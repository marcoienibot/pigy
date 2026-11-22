import { expect, it } from "vitest";
import { appPath, safeReturnTo } from "./return-to.ts";

it.each([
  ["/queue", "/queue"],
  ["/settings/access?tab=1#top", "/settings/access?tab=1#top"],
  // Encoded slashes stay encoded, so they stay part of the path.
  ["/%2F%2Fevil.example", "/%2F%2Fevil.example"],
])("keeps the path %j", (returnTo, expected) => {
  expect(safeReturnTo(returnTo)).toBe(expected);
});

// Each of these is read by a browser as an address on another host, or would
// be once the Worker put it in a Location header.
it.each([
  ["an absolute address", "https://evil.example/"],
  ["a protocol-relative address", "//evil.example"],
  ["a backslash, which browsers read as a slash", "/\\evil.example"],
  ["a tab, which browsers drop", "/\t/evil.example"],
  ["a newline, which browsers drop", "/\n/evil.example"],
  ["a dot segment that collapses into //", "/.//evil.example"],
  ["a parent segment that collapses into //", "/a/..//evil.example"],
  ["a dot segment followed by a backslash", "/./\\evil.example"],
  ["another scheme", "javascript:alert(1)"],
  ["a relative path", "queue"],
  ["an empty value", ""],
  ["no value", undefined],
  ["null", null],
])("falls back to the home page for %s", (_name, returnTo) => {
  expect(safeReturnTo(returnTo)).toBe("/");
});

it("returns the form a browser would resolve, not the raw input", () => {
  // The ".." is resolved here, so that the check and the redirect cannot
  // disagree about where this leads.
  expect(safeReturnTo("/settings/../queue")).toBe("/queue");
});

// Where a notification leads: the service worker reads the address back
// from the notification and may open a window there, and the window that
// it tells goes there. Both ask this.

it.each([
  ["a screen", "/inbox"],
  ["a screen with what it is to show", "/sent?post=1&inWorkspace=a-b"],
  ["the first screen", "/"],
])("takes %s for a path of the app", (_what, address) => {
  expect(appPath(address)).toBe(address);
});

it.each([
  ["an address at another site", "https://elsewhere.example/"],
  ["an address that leaves the site", "//elsewhere.example/"],
  // A browser reads a backslash as a slash, and drops a tab: it would
  // resolve both to another site.
  ["the same with a backslash", "/\\elsewhere.example/"],
  ["the same with a tab in it", "/\t/elsewhere.example/"],
  ["a script", "javascript:alert(1)"],
  ["what is no address", 7],
  ["no address at all", undefined],
])("takes %s for no path of the app", (_what, address) => {
  expect(appPath(address)).toBeNull();
});
