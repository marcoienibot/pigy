// Names that lead nowhere on the public internet, but may lead somewhere
// in the network of whoever runs pigy.
const privateSuffixes = [
  "localhost",
  "local",
  "internal",
  "lan",
  "home",
  "corp",
  "arpa",
  "onion",
];

/**
 * The domain of a Mastodon instance from what a person typed, or null if it
 * is not one. People type "mastodon.social", or paste "https://mastodon.social/"
 * from their browser. The result is the host name in lowercase, and in
 * Punycode if it has other than ASCII letters.
 *
 * The input is untrusted and decides which host pigy sends requests to, so
 * only a plain, public host name passes: no other protocol than HTTPS, no
 * port, no path, no credentials, no IP address and no name of a private
 * network. That a name is public says nothing about the address it resolves
 * to. Cloudflare Workers cannot reach private addresses, which is what
 * keeps a public name that points to one harmless.
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

  const host = url.hostname;
  const labels = host.split(".");
  if (host.length > 253 || labels.length < 2) return null;
  if (
    !labels.every((label) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    return null;
  }
  // The parser turns every spelling of an IPv4 address into four numbers.
  // No top-level domain is a number.
  if (!/[a-z]/.test(labels.at(-1) ?? "")) return null;
  if (privateSuffixes.some((suffix) => host.endsWith(`.${suffix}`)))
    return null;
  return host;
}
