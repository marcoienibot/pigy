import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";

it("answers unknown API paths with a JSON 404", async () => {
  const response = await exports.default.fetch("https://pigy.test/api/nope");

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    error: "NotFoundError",
    message: "Not found",
  });
});
