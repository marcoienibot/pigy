import type { z } from "zod";

/**
 * What to do about a failure. It is all a caller needs to decide on:
 *
 * - `retry`: nothing is wrong with the request. The network was busy, down
 *   or out of reach. Try again later, with the same input.
 * - `refresh`: the network refuses the credentials, and renewing them
 *   cures that. Refresh them now, whatever their `refreshAt` says, and try
 *   again with the new ones. `Provider.refresh` has the rules. Only a
 *   provider that has `refresh` fails this way.
 * - `fail`: trying again would fail again. Give up and tell the person why.
 * - `reconnect`: the network no longer accepts the credentials, and
 *   nothing but the person can change that. They have to connect the
 *   account again.
 * - `uncertain`: a post may or may not have been published, and the
 *   provider has no way to find out. Do not try again. A person has to
 *   look at the account, and only they can say whether to publish once
 *   more. Only `publishStep` fails this way, and `Provider.publishStep`
 *   says when.
 *
 * A caller that switches over the kinds must name every one of them.
 */
export type ProviderErrorKind =
  | "retry"
  | "refresh"
  | "fail"
  | "reconnect"
  | "uncertain";

/**
 * Every failure of a provider. Anything else that a provider throws is a
 * bug in it, or what the `fetch` it was given threw that is no failure of
 * a network: `send` of http.ts passes that on as it is. provider.ts says
 * what a caller does with it.
 *
 * The message is for the person whose post or connection it is about. It
 * may quote what the network answered, cut to a sensible length and with
 * the secrets of the request removed, so it is safe to store, show and log.
 */
export class ProviderError extends Error {
  /** With `retry`: not before this time, if the network named one. */
  readonly retryAt: Date | undefined;
  /** The HTTP status of the answer, if the network gave one. */
  readonly status: number | undefined;
  /**
   * The name of the error, if the network named one in a way that an
   * adapter reads, as atproto does in `error`: what an adapter tells one
   * refusal from another by, and never the words of its message.
   */
  readonly code: string | undefined;
  /**
   * True when a connection was not completed because the person said no
   * at the network. Nothing went wrong then, and a caller says so instead
   * of reporting a failure. Only `completeConnect` fails this way, with
   * `fail`.
   */
  readonly declined: boolean;
  /**
   * True with `retry` when the network does not show the one post that it
   * was asked about, yet or any more, and is fine otherwise: that post is
   * to wait, and the network can be asked about others meanwhile. A
   * `retry` without it is about the network: busy, down or out of reach.
   * Only `metrics` fails this way.
   */
  readonly notShown: boolean;

  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    options: {
      retryAt?: Date | undefined;
      status?: number | undefined;
      code?: string | undefined;
      declined?: boolean;
      notShown?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ProviderError";
    this.retryAt = options.retryAt;
    this.status = options.status;
    this.code = options.code;
    this.declined = options.declined ?? false;
    this.notShown = options.notShown ?? false;
  }
}

/**
 * A failure to complete a connection, as the contract wants it: for good.
 * The code of the callback is spent, or may be, so no second call can do
 * better, whatever the trouble of the network was. What is no
 * `ProviderError` is no failure of a network, and stays what it is.
 */
export function forGood(error: unknown): unknown {
  if (!(error instanceof ProviderError) || error.kind === "fail") {
    return error;
  }
  return new ProviderError(
    "fail",
    `${error.message} Connect the account again.`,
    { status: error.status, cause: error },
  );
}

/**
 * Makes the check that an adapter reads every answer with: the function
 * that it returns hands out `value` as `schema` describes it, and fails
 * for good otherwise, with what `message` says of `who` answered.
 */
export function understanding(message: (who: string) => string) {
  return <Schema extends z.ZodType>(
    schema: Schema,
    value: unknown,
    who: string,
  ): z.output<Schema> => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new ProviderError("fail", message(who));
    return parsed.data;
  };
}

// What stands in for a secret in a message.
const redacted = "[removed]";

/**
 * `text` as it may appear in a message: without the `secrets`, without
 * control characters and no longer than a sentence or two. Networks, and
 * the proxies in front of them, sometimes repeat a request in their answer.
 */
export function quotable(text: string, secrets: readonly string[]): string {
  let safe = text;
  for (const secret of secrets) {
    if (secret) safe = safe.replaceAll(secret, redacted);
  }
  // Control characters could forge lines in a log.
  safe = safe.replace(/\p{Cc}+/gu, " ").trim();
  // Cut after the secrets are out, so that no half of one is left behind,
  // and between code points, so that no half of a character is.
  const characters = Array.from(safe);
  return characters.length > 300
    ? `${characters.slice(0, 300).join("")}…`
    : safe;
}
