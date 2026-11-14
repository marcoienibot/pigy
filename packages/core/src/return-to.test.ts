import { expect, it } from "vitest";
import { safeReturnTo } from "./return-to.ts";

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
