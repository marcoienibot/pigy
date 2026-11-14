import { errorResponseSchema } from "@pigy/core";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { expect, it, onTestFinished, vi } from "vitest";
import { handleError } from "../src/errors.ts";
import app from "../src/index.ts";

/** Keeps an expected exception out of the test output. */
function silenceErrors() {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => log.mockRestore());
  return log;
}

it("answers an exception with a JSON 500 that does not leak it", async () => {
  // No route throws on purpose, and adding one for this test would ship it.
  // Instead, the health route is called with a binding that throws when the
  // route reads the version from it.
  const exception = new Error("secret detail");
  const env = {
    VERSION: {
      get id(): string {
        throw exception;
      },
    },
  };
  const log = silenceErrors();

  const response = await app.request("/api/health", {}, env);

  expect(response.status).toBe(500);
  const text = await response.text();
  expect(errorResponseSchema.parse(JSON.parse(text)).error).toBe(
    "UnexpectedError",
  );
  // Checked on the raw body, because parsing drops fields that are not in
  // the schema, such as a stack trace.
  expect(text).not.toContain("secret detail");
  // The exception must still reach the logs, or nobody could debug a 500.
  expect(log).toHaveBeenCalledWith(exception);
});

// The statuses that routes do not use yet are covered here, with routes
// that exist only in this test.
it.each([
  [400, "InvalidInputError"],
  [401, "UnauthorizedError"],
  [403, "UnauthorizedError"],
  [404, "NotFoundError"],
  [409, "InvalidInputError"],
  [429, "LimitReachedError"],
  [503, "UnexpectedError"],
] as const)(
  "answers an HTTPException with its status %i as a %s",
  async (status: ContentfulStatusCode, error) => {
    silenceErrors();
    const routes = new Hono().onError(handleError);
    routes.get("/with-message", () => {
      throw new HTTPException(status, { message: "What went wrong" });
    });
    routes.get("/without-message", () => {
      throw new HTTPException(status);
    });

    const withMessage = await routes.request("/with-message");
    const withoutMessage = await routes.request("/without-message");

    expect(withMessage.status).toBe(status);
    expect(errorResponseSchema.parse(await withMessage.json())).toEqual({
      error,
      message: "What went wrong",
    });
    // The message is required by the schema, so there has to be one even if
    // the route gave none.
    expect(withoutMessage.status).toBe(status);
    expect(errorResponseSchema.parse(await withoutMessage.json()).error).toBe(
      error,
    );
  },
);
