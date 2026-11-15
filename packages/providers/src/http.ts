import type { Fetch } from "@pigy/core";
import { ProviderError } from "./errors.ts";

/**
 * How adapters send a request. Whatever the network, they need the same
 * care: a network that does not answer must not hold up a workflow for
 * ever, an answer must not be larger than pigy is willing to read, and a
 * redirect must not carry a token to another host.
 */

export type HttpLimits = {
  /** How long to wait for an answer, in milliseconds. */
  timeoutMs: number;
  /** The longest body to read, in bytes. */
  maxBytes: number;
};

export type HttpAnswer = {
  status: number;
  headers: Headers;
  /** The body, if it is JSON. Undefined otherwise. */
  json: unknown;
  /** The body as text, whatever it is. */
  text: string;
};

/** The body of `response`, or null if it is longer than `maxBytes`. */
async function boundedText(
  response: Response,
  maxBytes: number,
): Promise<string | null> {
  // The header is a hint that spares the reading. The count below is what
  // holds, also for a server that sends no header or a wrong one.
  if (Number(response.headers.get("Content-Length")) > maxBytes) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}

/**
 * Sends a request to `url` and returns the answer, whatever its status.
 * `host` is how the messages name the other side.
 *
 * It fails with `retry` when no answer came: the host was out of reach, or
 * took too long. Whether the request arrived is unknown then. An adapter
 * that sends what must not happen twice sees to that itself, the way
 * `Provider.publishStep` says.
 *
 * Only a failure of the network is taken for one. Whatever else `fetch`
 * throws is thrown on as it is: it is a bug, or a check that failed, in
 * whatever stands behind `fetch`, and saying that a host could not be
 * reached would hide it.
 */
export async function send(
  fetch: Fetch,
  host: string,
  url: string,
  init: RequestInit,
  { timeoutMs, maxBytes }: HttpLimits,
): Promise<HttpAnswer> {
  const unreachable = (cause: unknown) =>
    new ProviderError("retry", `${host} could not be reached.`, { cause });
  const timeout = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      // A redirect is not followed: it could lead anywhere, and the request
      // carries credentials.
      redirect: "manual",
      signal: timeout,
    });
  } catch (cause) {
    // What a `fetch` that gets no answer fails with: a TypeError, and when
    // the time is up, whatever the runtime makes of the signal.
    if (!(cause instanceof TypeError) && !timeout.aborted) throw cause;
    throw unreachable(cause);
  }
  let text: string | null;
  try {
    text = await boundedText(response, maxBytes);
  } catch (cause) {
    // An answer that breaks off on the way, or takes too long. Nothing
    // else makes the reading of a body fail.
    throw unreachable(cause);
  }
  const { status, headers } = response;
  if (text === null) {
    throw new ProviderError(
      "fail",
      `${host} answered with more than pigy is willing to read.`,
      { status },
    );
  }
  // 0 is what a redirect looks like where the runtime hides it.
  if (status === 0 || (status >= 300 && status < 400)) {
    throw new ProviderError(
      "fail",
      `${host} sends pigy on to another address. Enter the address of the server itself.`,
      { status },
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status, headers, json, text };
}

/**
 * The time a `Retry-After` header names, or undefined. The header holds a
 * number of seconds or a date.
 */
export function retryAfter(headers: Headers, now: Date): Date | undefined {
  const value = headers.get("Retry-After")?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value))
    return new Date(now.getTime() + Number(value) * 1000);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** `value` if it is an HTTPS address, null otherwise. */
export function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/** Random bytes for a value that must not be guessed, as base64url. */
export function randomToken(bytes = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export async function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
}
