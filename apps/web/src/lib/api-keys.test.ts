import type { ApiKey } from "@pigy/core";
import { expect, it } from "vitest";
import { expiryOf, keyNotes } from "./api-keys.ts";

const day = 24 * 60 * 60 * 1000;
const now = new Date("2026-11-14T10:00:00Z").getTime();

const key = (fields: Partial<ApiKey>): ApiKey => ({
  id: "0123456789abcdef",
  name: "A script",
  prefix: "pigy_live_01234567",
  scopes: ["posts:read"],
  createdAt: now - 3 * day,
  lastUsedAt: null,
  expiresAt: null,
  ...fields,
});

it("says when a key was made and used, and when it ends or has ended", () => {
  expect(keyNotes(key({}), now)).toBe(
    "Created 3d ago · Never used · Never expires",
  );
  expect(keyNotes(key({ lastUsedAt: now - 5 * 60 * 1000 }), now)).toContain(
    "Last used 5m ago",
  );
  // A key that has ended is listed until it is revoked, and says so.
  const ends = new Date("2026-12-24T10:00:00Z").getTime();
  expect(keyNotes(key({ expiresAt: ends }), now)).toMatch(/Expires on .*24/);
  expect(keyNotes(key({ expiresAt: ends }), ends)).toMatch(/Expired on .*24/);
});

it("counts the life of a key from when it is made", () => {
  expect(expiryOf(null, now)).toBeNull();
  expect(expiryOf(30, now)).toBe(now + 30 * day);
});
