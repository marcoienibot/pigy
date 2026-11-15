import { publicHost } from "../host.ts";

/**
 * The domain of a Mastodon instance from what a person typed, or null if it
 * is not one. People type "mastodon.social", or paste "https://mastodon.social/"
 * from their browser. The result is the host name in lowercase, and in
 * Punycode if it has other than ASCII letters.
 *
 * The input is untrusted and decides which host pigy sends requests to, so
 * only a plain, public host name passes: no other protocol than HTTPS, no
 * port, no path, no credentials, and then what `publicHost` takes.
 */
export function parseInstanceDomain(input: string): string | null {
  let text = input.trim();
  if (/^https:\/\//i.test(text)) {
    text = text.slice("https://".length);
  }
  if (text.endsWith("/")) text = text.slice(0, -1);
  // What is left must be a host name and nothing else. These characters
  // begin the other parts of an address, or hide them: a port, a path, a
  // query, credentials, an IPv6 address, an escape.
  if (text === "" || /[\s/\\?#@:[\]%]/.test(text)) return null;

  let url: URL;
  try {
    url = new URL(`https://${text}`);
  } catch {
    return null;
  }
  // The parser has the last word on what it took the text for.
  if (url.host !== url.hostname || url.pathname !== "/") return null;
  if (url.username || url.password || url.search || url.hash) return null;

  return publicHost(url.hostname);
}
