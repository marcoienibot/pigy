import { expect, it } from "vitest";
import { emailSchema, normalizeEmail } from "./email.ts";

it("trims and lowercases", () => {
  expect(normalizeEmail("  Ada.Lovelace@Example.COM\n")).toBe(
    "ada.lovelace@example.com",
  );
});

it("keeps what only some providers ignore", () => {
  // Gmail delivers both of these to "adalovelace@gmail.com", other providers
  // deliver them to different mailboxes. Folding them would let one person's
  // invitation admit another.
  expect(normalizeEmail("ada.lovelace+pigy@gmail.com")).toBe(
    "ada.lovelace+pigy@gmail.com",
  );
});

it("parses to the normalized form", () => {
  // The normalization must run before the address is validated, or the
  // surrounding spaces would make it invalid.
  expect(emailSchema.parse(" Ada@Example.com ")).toBe("ada@example.com");
});

it.each([
  ["no domain", "ada"],
  ["no local part", "@example.com"],
  ["a space inside", "ada lovelace@example.com"],
  ["two addresses", "ada@example.com,bob@example.com"],
  ["a display name", "Ada <ada@example.com>"],
  ["a control character", "ada\u0000@example.com"],
  ["more than 254 characters", `${"a".repeat(243)}@example.com`],
  ["something that is not text", 42],
  ["a letter that is not ASCII", "ad\u00e4@example.com"],
])("rejects %s", (_name, value) => {
  expect(emailSchema.safeParse(value).success).toBe(false);
});

it("rejects a character that lowercasing would turn into an ASCII letter", () => {
  // U+212A, the Kelvin sign, looks like "K" and lowercases to "k". Were the
  // address checked after it is normalized, this one would pass as
  // "kate@example.com", which belongs to somebody else.
  const address = "\u212aate@example.com";
  // The address is one that normalizing does turn into an ASCII one. If it
  // were not, the rejection below would say nothing about the order.
  expect(normalizeEmail(address)).toBe("kate@example.com");

  expect(emailSchema.safeParse(address).success).toBe(false);
});
