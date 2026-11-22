import { expect, it } from "vitest";
import { fromBase64Url, toBase64Url } from "./base64url.ts";

it("writes bytes without the characters that an address or a header would change, and without padding", () => {
  // 0xfb 0xff 0xfe is "+//+" in base64, and one byte is padded with "==".
  expect(toBase64Url(Uint8Array.of(0xfb, 0xff, 0xfe))).toBe("-__-");
  expect(toBase64Url(Uint8Array.of(0xff))).toBe("_w");
  expect(toBase64Url(Uint8Array.of(1, 2, 3).buffer)).toBe("AQID");
});

it("reads back what it wrote, whatever the bytes", () => {
  const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);

  expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
  expect(fromBase64Url("")).toEqual(new Uint8Array());
});

it.each([
  ["base64 with its own characters", "+//+"],
  ["padding", "_w=="],
  ["a space", "AQ ID"],
  ["a length that no bytes have", "A"],
])("reads nothing from %s", (_what, text) => {
  expect(fromBase64Url(text)).toBeUndefined();
});
