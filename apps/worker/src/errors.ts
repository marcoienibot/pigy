import type { ErrorName, ErrorResponse } from "@pigy/core";
import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import { log } from "./log.ts";

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
 * Turns what a route throws into an error response. An `HTTPException` is a
 * route saying what went wrong, so its status and message go to the client.
 * Anything else is a bug: it goes to the logs, never to the client. What
 * goes to the logs goes through `loggable`, which `log` sees to, and names
 * the route by its method and its path: the query of an address can hold
 * the code of a callback.
 */
export const handleError: ErrorHandler = (error, c) => {
  const failed = () =>
    log.error(
      "request",
      "A request failed",
      { route: `${c.req.method} ${c.req.path}` },
      error,
    );
  if (error instanceof HTTPException) {
    if (error.status >= 500) failed();
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
  failed();
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
