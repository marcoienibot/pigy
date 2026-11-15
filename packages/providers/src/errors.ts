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
 * bug in it.
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

  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    options: {
      retryAt?: Date | undefined;
      status?: number | undefined;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ProviderError";
    this.retryAt = options.retryAt;
    this.status = options.status;
  }
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
