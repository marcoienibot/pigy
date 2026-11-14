import type { ErrorName, ErrorResponse } from "@pigy/core";
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

export const handleNotFound: NotFoundHandler = (c) =>
  c.json<ErrorResponse>(
    { error: "NotFoundError", message: defaultMessages.NotFoundError },
    404,
  );

/**
 * Turns what a route throws into an error response. An `HTTPException` is a
 * route saying what went wrong, so its status and message go to the client.
 * Anything else is a bug: it goes to the logs, never to the client.
 */
export const handleError: ErrorHandler = (error, c) => {
  if (error instanceof HTTPException) {
    if (error.status >= 500) console.error(error);
    const name = errorName(error.status);
    return c.json<ErrorResponse>(
      { error: name, message: error.message || defaultMessages[name] },
      error.status,
    );
  }
  console.error(error);
  return c.json<ErrorResponse>(
    { error: "UnexpectedError", message: defaultMessages.UnexpectedError },
    500,
  );
};

/** The JSON body of a request, or a 400 that says what is wrong with it. */
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
    throw new HTTPException(400, {
      message: path ? `${path}: ${message}` : message,
    });
  }
  return parsed.data;
}
