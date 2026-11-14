import { exports } from "cloudflare:workers";
import { errorResponseSchema } from "@pigy/core";
import { expect, it } from "vitest";

it("answers unknown API paths with a JSON 404", async () => {
  const response = await exports.default.fetch("https://pigy.test/api/nope");

  expect(response.status).toBe(404);
  const body = errorResponseSchema.parse(await response.json());
  expect(body.error).toBe("NotFoundError");
});
