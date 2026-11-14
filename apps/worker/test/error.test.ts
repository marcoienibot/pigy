import { errorResponseSchema } from "@pigy/core";
import { expect, it, onTestFinished, vi } from "vitest";
import app from "../src/index.ts";

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
  // Also keeps the expected exception out of the test output.
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => log.mockRestore());

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
