import { expect, it } from "vitest";
import { createApiKeyRequestSchema, maxApiTime } from "./keys.ts";
import { apiPostSchema, apiTime, createPostRequestSchema } from "./v1.ts";

const timeSchema = apiPostSchema.shape.createdAt;

it("says every time that a row can hold in the form that its answers promise", () => {
  expect(apiTime(0)).toBe("1970-01-01T00:00:00.000Z");
  expect(apiTime(maxApiTime)).toBe("9999-12-31T23:59:59.999Z");
  // A date writes the year after with six digits, which the schema of an
  // answer refuses: this is why a later time is said as the last one.
  expect(timeSchema.safeParse(new Date(maxApiTime + 1).toISOString())).toEqual(
    expect.objectContaining({ success: false }),
  );
  for (const late of [maxApiTime + 1, Date.UTC(20266, 0, 1), 8.64e15]) {
    expect(apiTime(late)).toBe("9999-12-31T23:59:59.999Z");
    expect(timeSchema.parse(apiTime(late))).toBe(apiTime(late));
  }
});

it("takes no time that it could not say", () => {
  const post = (dueAt: string) =>
    createPostRequestSchema.safeParse({
      text: "Later",
      mode: "customScheduled",
      dueAt,
    }).success;
  expect(post("9999-12-31T23:59:59.999Z")).toBe(true);
  // The year 9999 where it is written, and the year after in UTC.
  expect(post("9999-12-31T23:59:59-01:00")).toBe(false);
  expect(post("+010000-01-01T00:00:00Z")).toBe(false);

  const key = (expiresAt: number) =>
    createApiKeyRequestSchema.safeParse({
      name: "A script",
      scopes: ["posts:read"],
      expiresAt,
    }).success;
  expect(key(maxApiTime)).toBe(true);
  expect(key(maxApiTime + 1)).toBe(false);
});
