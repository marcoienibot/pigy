import type { Fetch } from "@pigy/core";
import { publicUrl } from "./host.ts";
import { redirects, timeLimit } from "./http.ts";

/**
 * Fetches the file at an address that a request of the public API names
 * as an image of a post, `image.url` of an asset, and hands its bytes on
 * as they come. The address is anybody's, and so is what answers at it,
 * so the request is guarded as the one for the card of a link is, card.ts:
 *
 * - **Where it goes.** Only to an HTTPS address at a public host,
 *   `publicUrl` of host.ts: no address of a private network, no IP
 *   address, no port, and none of pigy's own hosts. It may be sent on a
 *   few times, and only to such an address again.
 * - **What it carries.** Nothing: no credentials, no cookie, nothing of
 *   the person or of the post. It is a `GET`.
 * - **How long.** The whole way, the bytes included, has the time of one
 *   request: a host that sends pigy on, or sends slowly, gets no more.
 * - **How much.** Only an answer with the status 200, and of that no more
 *   than `maxBytes`: a length that the answer declares beyond it is
 *   refused before anything is read, and a body that goes beyond it is
 *   given up there.
 * - **What it is.** Not decided here, and never by the type that the
 *   answer names: the caller reads the bytes, `scanImage` of @pigy/core.
 *
 * Whatever goes wrong at the other end is an `AssetRefused`, whose
 * message says what in words for whoever named the address, and holds
 * nothing of the address or of what answered there: it can go into an
 * answer, and nothing of either goes into a log. What is no failure of
 * the other end, such as a check of a simulated world that refuses, or a
 * failure of `sink`, comes out as it is.
 */

export type AssetLimits = {
  /** How long the whole way may take, the bytes included, in milliseconds. */
  timeoutMs: number;
  /** How often the request may be sent on. */
  hops: number;
  /** How many bytes the file may have. */
  maxBytes: number;
};

/** Why the file at an address was not fetched, in words for its sender. */
export class AssetRefused extends Error {
  override name = "AssetRefused";
}

/** What `fetchAsset` can be told besides the address. */
export type AssetOptions = {
  /**
   * The hosts of pigy itself, as `URL.host` writes them, which are never
   * asked, at first or where an answer sends the request on: see
   * `CardOptions` of card.ts.
   */
  ownHosts?: readonly string[];
};

/**
 * Fetches the file at `address` with `fetch` and hands each piece of it
 * to `sink`, in order, which is waited for before the next is read.
 * Returns how many bytes it handed on, one at least. The top of this file
 * has the rules.
 */
export async function fetchAsset(
  fetch: Fetch,
  address: string,
  limits: AssetLimits,
  sink: (piece: Uint8Array) => Promise<void>,
  { ownHosts = [] }: AssetOptions = {},
): Promise<number> {
  let first: URL;
  try {
    first = new URL(address);
  } catch {
    throw new AssetRefused("This is not an address.");
  }
  // What stands after "#" is for the browser, and is not sent.
  first.hash = "";
  const asks = (url: string | null): url is string =>
    url !== null && !ownHosts.includes(new URL(url).host);
  const start = publicUrl(first.href);
  if (!asks(start)) {
    throw new AssetRefused(
      "pigy fetches an image only at an HTTPS address of a public host, without a port.",
    );
  }
  const deadline = timeLimit(limits.timeoutMs);
  const late = () =>
    new AssetRefused(
      `The image did not arrive within ${limits.timeoutMs / 1000} seconds.`,
    );
  /** What failed on the way, as the other end's or as it is. */
  const failed = (cause: unknown) => {
    // A `fetch` that gets no answer fails with a TypeError, and when the
    // time is up, with whatever the runtime makes of the signal.
    if (deadline.signal.aborted) return late();
    if (cause instanceof TypeError) {
      return new AssetRefused("The address could not be reached.", { cause });
    }
    return cause;
  };
  try {
    let at = start;
    for (let hop = 0; ; hop++) {
      let response: Response;
      try {
        response = await fetch(at, {
          method: "GET",
          headers: { Accept: "image/*", "User-Agent": "pigy (image)" },
          // Followed here, where each address is looked at.
          redirect: "manual",
          signal: deadline.signal,
        });
      } catch (cause) {
        throw failed(cause);
      }
      if (redirects(response.status)) {
        await response.body?.cancel().catch(() => {});
        const location = response.headers.get("Location");
        let next: string | null = null;
        try {
          next =
            location === null ? null : publicUrl(new URL(location, at).href);
        } catch {
          next = null;
        }
        if (!asks(next) || hop >= limits.hops) {
          throw new AssetRefused(
            `The address sends pigy on to an address that it does not follow: an HTTPS address of a public host, ${limits.hops} times at most.`,
          );
        }
        at = next;
        continue;
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {});
        throw new AssetRefused(
          `The address answered with the status ${response.status}, and not with a file.`,
        );
      }
      const tooLarge = () =>
        new AssetRefused(
          `The file is larger than ${limits.maxBytes / 1024 / 1024} MiB.`,
        );
      // The header is a hint that spares the reading. The count below is
      // what holds, also for a server that sends no header or a wrong one.
      if (Number(response.headers.get("Content-Length")) > limits.maxBytes) {
        await response.body?.cancel().catch(() => {});
        throw tooLarge();
      }
      const reader = response.body?.getReader();
      let bytes = 0;
      if (reader) {
        for (;;) {
          let read: ReadableStreamReadResult<Uint8Array>;
          try {
            read = await reader.read();
          } catch (cause) {
            // A body that breaks off, or takes too long.
            throw failed(cause);
          }
          if (read.done) break;
          bytes += read.value.byteLength;
          if (bytes > limits.maxBytes) {
            await reader.cancel().catch(() => {});
            throw tooLarge();
          }
          if (read.value.byteLength > 0) await sink(read.value);
          // A sink that is slower than the time: what it was handed is
          // its own, and the rest is not read.
          if (deadline.signal.aborted) {
            await reader.cancel().catch(() => {});
            throw late();
          }
        }
      }
      if (bytes === 0) {
        throw new AssetRefused("The address answered with no file.");
      }
      return bytes;
    }
  } finally {
    deadline.clear();
  }
}
