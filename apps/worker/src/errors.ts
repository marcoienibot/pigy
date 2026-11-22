import type { ErrorName, ErrorResponse } from "@pigy/core";
import { DrizzleQueryError } from "drizzle-orm";
import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
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
 * A refusal that is about one field of the request: a 400, unless `status`
 * says otherwise. The answer names the field, for a form to show the
 * message next to it.
 */
export class InvalidField extends HTTPException {
  constructor(
    readonly field: string,
    message: string,
    status: ContentfulStatusCode = 400,
  ) {
    super(status, { message });
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
 * The same goes for an error that has such a one beneath it: as its cause
 * or further down, among the errors that an `AggregateError` gathers, or
 * in a plain object or a list that is a cause. A log prints all of those.
 * It is logged as a copy that has the cleaned one in that place.
 *
 * What it cannot find is a message that somebody has made from the message
 * of such an error. Nothing in the app does that: an error is passed on as
 * a cause, never quoted.
 *
 * Every error that a route lets through is logged this way, below. Code
 * that catches an error which the database may have thrown, and logs it
 * itself, calls this.
 */
export function loggable(error: unknown): unknown {
  return cleaned(error, new WeakSet());
}

// What stands in a log where an error leads back to one that is being
// cleaned already. Causes can go in a circle, and this runs where errors
// are handled: it must come to an end, and it must not throw.
const circular = "[circular]";

function cleaned(value: unknown, onTheWay: WeakSet<object>): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (onTheWay.has(value)) return circular;
  onTheWay.add(value);
  try {
    if (Array.isArray(value)) return cleanedList(value, onTheWay);
    if (value instanceof Error) return cleanedError(value, onTheWay);
    // Anything else that is not a plain object is left as it is: what it
    // holds is its own business, and a log does not look into it.
    if (Object.getPrototypeOf(value) !== Object.prototype) return value;
    const entries = Object.entries(value);
    const clean = entries.map(([, held]) => cleaned(held, onTheWay));
    return clean.every((held, index) => held === entries[index]?.[1])
      ? value
      : Object.fromEntries(entries.map(([key], index) => [key, clean[index]]));
  } finally {
    // Only what leads back to itself is a circle. The same error in two
    // places is cleaned in both.
    onTheWay.delete(value);
  }
}

function cleanedList(list: unknown[], onTheWay: WeakSet<object>): unknown[] {
  const clean = list.map((held) => cleaned(held, onTheWay));
  return clean.every((held, index) => held === list[index]) ? list : clean;
}

function cleanedError(error: Error, onTheWay: WeakSet<object>): unknown {
  const cause = cleaned(error.cause, onTheWay);
  if (error instanceof DrizzleQueryError) {
    return new Error(`Failed query: ${error.query}`, { cause });
  }
  const gathered =
    error instanceof AggregateError
      ? cleanedList(error.errors, onTheWay)
      : undefined;
  const same =
    cause === error.cause &&
    (!(error instanceof AggregateError) || gathered === error.errors);
  if (same) return error;
  const copy = gathered
    ? new AggregateError(gathered, error.message, { cause })
    : new Error(error.message, { cause });
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
  return parseInput(body, schema);
}

/**
 * `input` as `schema` has it, or a 400 that says what is wrong with it, and
 * with which of its fields if it is one.
 */
export function parseInput<T>(input: unknown, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    const path = issue?.path.join(".");
    const message = issue?.message ?? "The request is invalid";
    if (path) throw new InvalidField(path, `${path}: ${message}`);
    throw new HTTPException(400, { message });
  }
  return parsed.data;
}
