import { DrizzleQueryError } from "drizzle-orm";

/**
 * The log of the Worker: one line of JSON for everything that went wrong,
 * which whoever runs pigy can search by its fields. `log` is the only code
 * of the Worker that writes to the console: Biome refuses `console`
 * everywhere else in `src`.
 *
 * What a line never holds: a secret, sealed or not, the text of a post,
 * the address or the name of a person or an account, and the query of an
 * address, which can hold the code of a callback or the token of an
 * account. It names things by their IDs.
 */

/**
 * What an entry is about, to search by. A failure of pigy's own and a
 * refusal of somebody else's have the same kind and differ in their
 * level: an `error` is for whoever runs pigy to look at, a `warn` is how
 * something ended that pigy has dealt with.
 */
export type LogKind =
  /** A route threw: the answer was a 500. */
  | "request"
  /** A secret of the Worker is missing or not valid. */
  | "configuration"
  | "sign-in"
  /** Connecting and disconnecting an account. */
  | "connection"
  /** Renewing the access of a channel by the timer. */
  | "renewal"
  /** Publishing: the workflow, and the workspace that looks after it. */
  | "delivery"
  /** The scheduled posts of a workspace. */
  | "schedule"
  | "push"
  /** The sync protocol: a mutation, a message, a patch. */
  | "sync"
  /** The alarm of a workspace, which could not be set. */
  | "alarm";

/** Where it happened, as far as the place knows. All of it is IDs. */
export type LogContext = {
  /** The method and the path of a request, without its query. */
  route?: string;
  /** The step of a workflow, or what the alarm of a workspace was at. */
  step?: string;
  workspaceId?: string;
  channelId?: string;
  targetId?: string;
  postId?: string;
  network?: string;
  /** The host of a push service. */
  host?: string;
  /** The status that somebody else answered with. */
  status?: number;
};

type Level = "warn" | "error";

// How far down the causes of an error are followed. `loggable` ends a
// circle, and this ends everything else that is deeper than any real error.
const deepest = 8;

/**
 * What an error says of itself besides its name and its message, by the
 * names of the properties that say it: the kind and the status of a
 * `ProviderError`, the code of an error of a library, what the runtime
 * says of a failed call into a Durable Object. A property by another
 * name is not logged, whatever it holds: libraries put the answer of a
 * server there, or what was sent to it.
 */
const toldOf = new Set([
  "kind",
  "status",
  "declined",
  "code",
  "retryable",
  "overloaded",
]);

/**
 * `value` as JSON has it: an error with its stack and the errors beneath
 * it, and nothing else. A value that is no error is somebody's data, and
 * a line says what kind of thing it is and nothing of what it holds: a
 * library makes the cause of its error of what it compared, which can be
 * the parameters of a callback, the claims of a token, the headers of a
 * request or an answer. Only a list or a plain object is looked into, for
 * the errors that it holds, which `loggable` has cleaned.
 */
function described(value: unknown, depth = 0): unknown {
  if (value === circular) return circular;
  if (depth > deepest) return "[too deep]";
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...Object.fromEntries(
        Object.entries(value).filter(
          ([name, held]) =>
            toldOf.has(name) &&
            ["string", "number", "boolean"].includes(typeof held),
        ),
      ),
      stack: value.stack,
      ...(value instanceof AggregateError && {
        errors: described(value.errors, depth + 1),
      }),
      ...(value.cause !== undefined && {
        cause: described(value.cause, depth + 1),
      }),
    };
  }
  if (Array.isArray(value)) {
    return value.map((held) => described(held, depth + 1));
  }
  if (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([name, held]) => [
        name,
        described(held, depth + 1),
      ]),
    );
  }
  // "[object String]", "[object URLSearchParams]", "[object Response]":
  // never `String(value)`, which is the query of a URL and the whole of a
  // string.
  return Object.prototype.toString.call(value);
}

function write(
  level: Level,
  kind: LogKind,
  message: string,
  context: LogContext,
  error: unknown,
): void {
  const entry = {
    level,
    kind,
    message,
    ...context,
    ...(error !== undefined && { error: described(loggable(error)) }),
  };
  let line: string;
  try {
    line = JSON.stringify(entry);
  } catch {
    // Nothing that `described` returns fails here, as far as anybody
    // knows. A log must not throw where an error is being handled.
    line = JSON.stringify({ level, kind, message, ...context });
  }
  // biome-ignore lint/suspicious/noConsole: this is the log.
  console[level](line);
}

export const log = {
  /**
   * Something ended badly that pigy has dealt with: a network refused, a
   * person cancelled, a key is gone and the account asks to be connected
   * again.
   */
  warn(
    kind: LogKind,
    message: string,
    context: LogContext = {},
    error?: unknown,
  ): void {
    write("warn", kind, message, context, error);
  },
  /** Something for whoever runs pigy to look at: a bug, or a setup. */
  error(
    kind: LogKind,
    message: string,
    context: LogContext = {},
    error?: unknown,
  ): void {
    write("error", kind, message, context, error);
  },
};

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
 * Every error that is logged goes through this: `log` below is the one
 * way into the log, and passes what it is given through here.
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
