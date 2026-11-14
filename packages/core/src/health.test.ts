import { expect, it } from "vitest";
import { healthResponseSchema } from "./health.ts";

it("accepts a healthy response", () => {
  const response = { status: "ok", version: "4f2c1a9e" };

  expect(healthResponseSchema.parse(response)).toEqual(response);
});

// The web app treats anything that fails this schema as "API unreachable",
// for example an HTML error page or a JSON error from a proxy in between.
it.each([
  ["another status", { status: "degraded", version: "4f2c1a9e" }],
  ["a missing version", { status: "ok" }],
  ["an empty version", { status: "ok", version: "" }],
  ["a non-object body", "<!doctype html>"],
])("rejects %s", (_name, response) => {
  expect(healthResponseSchema.safeParse(response).success).toBe(false);
});
