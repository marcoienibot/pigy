/**
 * The hosts that pigy sends requests to because somebody named them: the
 * domain of a Mastodon instance that a person typed, a Bluesky handle, and
 * the servers that the DID document of an account and the metadata of a
 * server name, which whoever controls the account writes. Only a public
 * host passes: a name, with no port, that leads nowhere private.
 *
 * That a name is public says nothing about the address it resolves to.
 * Cloudflare Workers cannot reach private addresses, which is what keeps a
 * public name that points to one harmless.
 */

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
 * `host` if it is the name of a public host, as `URL.hostname` writes it:
 * in lowercase and in Punycode. Null for an IP address, a name of one
 * label, a name of a private network, and what is no host name.
 */
export function publicHost(host: string): string | null {
  const labels = host.split(".");
  if (host.length > 253 || labels.length < 2) return null;
  // An IPv6 address, in brackets, fails here.
  if (
    !labels.every((label) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    return null;
  }
  // A URL parser turns every spelling of an IPv4 address into four numbers.
  // No top-level domain is a number.
  if (!/[a-z]/.test(labels.at(-1) ?? "")) return null;
  if (privateSuffixes.some((suffix) => host.endsWith(`.${suffix}`))) {
    return null;
  }
  return host;
}

/**
 * `value` as an HTTPS address at a public host, with no port other than
 * that of HTTPS, no credentials and no fragment, or null.
 */
function publicHttps(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === "https:" &&
    // The parser leaves out the port of HTTPS, 443, when it is named.
    url.port === "" &&
    !url.username &&
    !url.password &&
    !url.hash &&
    publicHost(url.hostname) !== null
    ? url
    : null;
}

/**
 * `value` as an address that pigy may send a request to: HTTPS, at a
 * public host, with no port, credentials or fragment. Null otherwise. A
 * path and a query may be there.
 */
export function publicUrl(value: unknown): string | null {
  return publicHttps(value)?.href ?? null;
}

/**
 * The origin of `value` if it is the address of a server: HTTPS, at a
 * public host, with no port, credentials, path, query or fragment. Null
 * otherwise.
 */
export function publicOrigin(value: unknown): string | null {
  const url = publicHttps(value);
  return url && url.pathname === "/" && !url.search ? url.origin : null;
}
