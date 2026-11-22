import { errorResponseSchema } from "@pigy/core";
import { DrizzleQueryError } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { expect, it, onTestFinished, vi } from "vitest";
import { handleError } from "../src/errors.ts";
import app from "../src/index.ts";
import { loggable } from "../src/log.ts";
import { logged } from "./helpers.ts";

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
  // The exception must still reach the logs, or nobody could debug a 500:
  // as one line of JSON, with what failed and where it was thrown.
  expect(log).toHaveBeenCalledOnce();
  const line = String(log.mock.calls[0]?.[0]);
  expect(line).not.toContain("\n");
  expect(JSON.parse(line)).toEqual({
    level: "error",
    kind: "request",
    message: "A request failed",
    route: "GET /api/health",
    error: {
      name: "Error",
      message: "secret detail",
      stack: exception.stack,
    },
  });
});

// A query that failed, as Drizzle reports it: with the values that it was
// run with.
const failedQuery = () =>
  new DrizzleQueryError(
    'select "id" from "session" where "session"."id" = ?',
    ["the-hash-of-a-session"],
    new Error("D1_ERROR: The database is in trouble"),
  );

it.each([
  ["is what a route fails with", failedQuery],
  [
    "is the cause of what a route fails with",
    () => new Error("The session was not found", { cause: failedQuery() }),
  ],
  [
    "is beneath the cause of what a route answers with",
    () =>
      new HTTPException(503, {
        cause: new Error("Not now", { cause: failedQuery() }),
      }),
  ],
  [
    "is one of several failures that a route fails with",
    () => new AggregateError([new Error("Another"), failedQuery()], "Two"),
  ],
  [
    "is in an object that is the cause of what a route fails with",
    () => new Error("Not stored", { cause: { error: failedQuery() } }),
  ],
])(
  "logs a query that failed without its values when it %s",
  async (_name, failure) => {
    const log = silenceErrors();
    const routes = new Hono().onError(handleError);
    routes.get("/", () => {
      throw failure();
    });

    await routes.request("/");

    expect(log).toHaveBeenCalledOnce();
    const text = log.mock.calls.flat().map(logged).join("\n");
    // What failed and why, for whoever reads the log. A log prints the
    // causes of an error too, so the values must be in none of them.
    expect(text).toContain('from "session"');
    expect(text).toContain("The database is in trouble");
    expect(text).not.toContain("the-hash-of-a-session");
  },
);

it("comes to an end with an error whose causes go in a circle", () => {
  const first = new Error("First");
  const second = new Error("Second", { cause: first });
  first.cause = second;
  const itself = failedQuery();
  itself.cause = itself;

  // This runs where errors are handled. Going round for ever would end in
  // an exception of its own, in place of the answer and of the log.
  const [two, one] = [loggable(second), loggable(itself)].map(logged);

  expect(two).toContain("Second");
  expect(two).toContain("First");
  expect(one).toContain('from "session"');
  expect(one).not.toContain("the-hash-of-a-session");
});

it("cleans an error in every place that it stands in", () => {
  const query = failedQuery();
  // The same error twice is no circle: it is cleaned both times.
  const failure = new AggregateError([query, query], "Twice");

  expect(logged(loggable(failure))).not.toContain("the-hash-of-a-session");
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
