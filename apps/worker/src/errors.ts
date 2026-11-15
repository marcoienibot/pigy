import type { ErrorName, ErrorResponse } from "@pigy/core";
import { DrizzleQueryError } from "drizzle-orm";
import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";

function errorName(status: number): ErrorName {
  if (status === 401 || status === 403) return "UnauthorizedError";
  if (status === 404) return "NotFoundError";
  if (status === 429) return "LimitReachedError";
  return status < 500 ? "InvalidInputError" : "UnexpectedError";
}

// For an `HTTPException` that was thrown without a message.
const defaultMessages: Record<ErrorName, string> = {
  InvalidInputError: "Invalid request",
  NotFoundError: "Not found",
  UnauthorizedError: "Not allowed",
  LimitReachedError: "Too many requests",
  UnexpectedError: "Something went wrong",
};

/**
 * A 400 that is about one field of the request. The answer names the field,
 * for a form to show the message next to it.
 */
export class InvalidField extends HTTPException {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(400, { message });
  }
}

export const handleNotFound: NotFoundHandler = (c) =>
  c.json<ErrorResponse>(
    { error: "NotFoundError", message: defaultMessages.NotFoundError },
    404,
  );

/**
 * `error` as it may be logged. A query that failed says so with the values
 * it was run with, as Drizzle reports it: in its message, in its stack and
 * as a property. Those are not for a log. Some are secrets, sealed or
 * hashed: a registration that was to be stored, the session that was looked
 * up, the `state` of a callback. What is logged in place of such an error
 * has the statement and the reason, without the values.
 *
 * The same goes for an error that has such a one beneath it, as its cause
 * or further down: a log prints the causes too. It is logged as a copy
 * that has the cleaned one in that place.
 *
 * Every error that a route lets through is logged this way, below. Code
 * that catches an error which the database may have thrown, and logs it
 * itself, calls this.
 */
export function loggable(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const cause = loggable(error.cause);
  if (error instanceof DrizzleQueryError) {
    return new Error(`Failed query: ${error.query}`, { cause });
  }
  if (cause === error.cause) return error;
  const copy = new Error(error.message, { cause });
  copy.name = error.name;
  // The stack of the copy says where the copy was made. What a log needs
  // is where the error was thrown.
  if (error.stack) copy.stack = error.stack;
  return copy;
}

/**
 * Turns what a route throws into an error response. An `HTTPException` is a
 * route saying what went wrong, so its status and message go to the client.
 * Anything else is a bug: it goes to the logs, never to the client. What
 * goes to the logs goes through `loggable`.
 */
export const handleError: ErrorHandler = (error, c) => {
  if (error instanceof HTTPException) {
    if (error.status >= 500) console.error(loggable(error));
    const name = errorName(error.status);
    return c.json<ErrorResponse>(
      {
        error: name,
        message: error.message || defaultMessages[name],
        ...(error instanceof InvalidField && { field: error.field }),
      },
      error.status,
    );
  }
  console.error(loggable(error));
  return c.json<ErrorResponse>(
    { error: "UnexpectedError", message: defaultMessages.UnexpectedError },
    500,
  );
};

/**
 * The JSON body of a request, or a 400 that says what is wrong with it, and
 * with which of its fields if it is one.
 */
export async function parseJsonBody<T>(
  c: Context,
  schema: z.ZodType<T>,
): Promise<T> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "The body must be JSON" });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    const path = issue?.path.join(".");
    const message = issue?.message ?? "The body is invalid";
    if (path) throw new InvalidField(path, `${path}: ${message}`);
    throw new HTTPException(400, { message });
  }
  return parsed.data;
}
