import { describe, expect, it } from "vitest";
import { parseInstanceDomain } from "./domain.ts";

describe("parseInstanceDomain", () => {
  it.each([
    ["mastodon.social", "mastodon.social"],
    ["  Mastodon.Social ", "mastodon.social"],
    // Pasted from the address bar.
    ["https://mastodon.social", "mastodon.social"],
    ["HTTPS://mastodon.social/", "mastodon.social"],
    ["social.example.co.uk", "social.example.co.uk"],
    ["mastodon.example", "mastodon.example"],
    // Other than ASCII letters, in the form the request is sent with.
    ["grå.org", "xn--gr-zia.org"],
  ])("takes %j for %s", (input, domain) => {
    expect(parseInstanceDomain(input)).toBe(domain);
  });

  it.each([
    [""],
    ["   "],
    ["mastodon"],
    // Only HTTPS.
    ["http://mastodon.social"],
    ["ftp://mastodon.social"],
    ["javascript:alert(1)"],
    // Nothing but a host.
    ["mastodon.social/@ada"],
    ["mastodon.social/api/v1/instance"],
    ["mastodon.social?x=1"],
    ["mastodon.social#x"],
    ["mastodon.social:8443"],
    ["https://mastodon.social:443"],
    // What a URL parser would read as credentials, with another host
    // behind them.
    ["ada@mastodon.social"],
    ["mastodon.social@evil.example"],
    ["ada:secret@mastodon.social"],
    ["mastodon.social\\@evil.example"],
    ["mastodon.social%2f@evil.example"],
    ["mastodon.social evil.example"],
    ["mastodon.social\nevil.example"],
    // Addresses, in every spelling a URL parser accepts.
    ["127.0.0.1"],
    ["127.1"],
    ["2130706433"],
    ["0x7f.0.0.1"],
    ["017700000001"],
    ["[::1]"],
    ["[::ffff:127.0.0.1]"],
    ["169.254.169.254"],
    // Names of private networks.
    ["localhost"],
    ["pigy.localhost"],
    ["printer.local"],
    ["db.internal"],
    ["router.lan"],
    ["1.0.0.127.in-addr.arpa"],
    // Not host names.
    ["mastodon..social"],
    ["-mastodon.social"],
    ["mastodon_social.example"],
    ["mastodon.social."],
    [`${"a".repeat(64)}.example`],
    [`${"a.".repeat(127)}example`],
  ])("refuses %j", (input) => {
    expect(parseInstanceDomain(input)).toBeNull();
  });
});
