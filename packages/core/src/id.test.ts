import { expect, it } from "vitest";
import { idSchema, uuidv7 } from "./id.ts";

it("makes IDs that the schema accepts", () => {
  // Many, because 3 of 4 random values would pass a wrong variant digit.
  for (let i = 0; i < 200; i++) {
    const id = uuidv7(new Date("2026-11-14T10:00:00Z"));
    expect(idSchema.safeParse(id).success, id).toBe(true);
  }
});

it("puts the time first, so that IDs sort by when they were made", () => {
  const earlier = uuidv7(new Date("2026-11-14T10:00:00.000Z"));
  const later = uuidv7(new Date("2026-11-14T10:00:00.001Z"));

  expect(earlier < later).toBe(true);
  // RFC 9562: the first 48 bits are the Unix time in milliseconds.
  expect(Number.parseInt(earlier.replace("-", "").slice(0, 12), 16)).toBe(
    new Date("2026-11-14T10:00:00.000Z").getTime(),
  );
});

it("does not repeat an ID made in the same millisecond", () => {
  const now = new Date("2026-11-14T10:00:00Z");
  const ids = new Set(Array.from({ length: 1000 }, () => uuidv7(now)));

  expect(ids.size).toBe(1000);
});

it.each([
  ["a UUID of another version", "0192e4a0-7b1c-4def-8abc-0123456789ab"],
  // The same UUID in two spellings would be two rows.
  ["capitals", "0192E4A0-7B1C-7DEF-8ABC-0123456789AB"],
  ["another variant", "0192e4a0-7b1c-7def-cabc-0123456789ab"],
  ["no hyphens", "0192e4a07b1c7def8abc0123456789ab"],
  ["text around a UUID", " 0192e4a0-7b1c-7def-8abc-0123456789ab\n"],
  ["a number", 7],
])("rejects %s as an ID", (_name, id) => {
  expect(idSchema.safeParse(id).success).toBe(false);
});
