import { exports } from "cloudflare:workers";
import { healthResponseSchema } from "@pigy/core";
import { expect, it } from "vitest";

it("reports health in the shape the web app expects", async () => {
  const response = await exports.default.fetch("https://pigy.test/api/health");

  expect(response.status).toBe(200);
  // The web app parses the response with this same schema, so a mismatch
  // here would break the home page.
  const parsed = healthResponseSchema.safeParse(await response.json());
  expect(parsed.error).toBeUndefined();
});
