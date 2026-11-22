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
 *
 * One kind of host is public by its name and still not asked the way a
 * stranger asks it: a host of the Cloudflare zone that pigy itself is
 * deployed on. By default a `fetch` of a Worker to such a host goes
 * straight to its origin, past the firewall of the zone and past
 * Cloudflare Access. With pigy at `pigy.example.com`, somebody who is
 * invited could then have pigy read them the title of a page at
 * `wiki.example.com` that only Access protects, as the card of a link.
 * Nothing in a name tells such a host from any other, so this cannot
 * refuse it. The Worker is deployed with the compatibility flag
 * `global_fetch_strictly_public`, apps/worker/wrangler.jsonc, which sends
 * every `fetch` to a public host through the front door. `fetchLinkCard`
 * of card.ts refuses the hosts of pigy itself besides, where its caller
 * knows them. That the flag does this for the way pigy is deployed is
 * to be confirmed on the deployment: PLAN.md section 19.
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
