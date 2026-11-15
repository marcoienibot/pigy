import { describe, expect, it } from "vitest";
import { publicHost, publicOrigin, publicUrl } from "./host.ts";

describe("publicHost", () => {
  it.each([
    "bsky.social",
    "pds.bsky.test",
    "morel.us-east.host.bsky.network",
    "xn--gr-zia.org",
  ])("takes %s", (host) => {
    expect(publicHost(host)).toBe(host);
  });

  it.each([
    "",
    "bsky",
    "localhost",
    // As a URL parser writes addresses.
    "127.0.0.1",
    "10.0.0.5",
    "[::1]",
    // Names of private networks.
    "pigy.localhost",
    "printer.local",
    "db.internal",
    "router.lan",
    "nas.home",
    "intranet.corp",
    "1.0.0.127.in-addr.arpa",
    "hidden.onion",
    // Not host names.
    "bsky..social",
    "-bsky.social",
    "bsky_social.example",
    `${"a".repeat(64)}.example`,
  ])("refuses %j", (host) => {
    expect(publicHost(host)).toBeNull();
  });
});

describe("publicUrl and publicOrigin", () => {
  it("take an HTTPS address at a public host", () => {
    expect(publicUrl("https://bsky.social/oauth/token")).toBe(
      "https://bsky.social/oauth/token",
    );
    expect(publicUrl("https://bsky.social/oauth/par?x=1")).toBe(
      "https://bsky.social/oauth/par?x=1",
    );
    expect(publicOrigin("https://pds.bsky.test")).toBe("https://pds.bsky.test");
    expect(publicOrigin("https://pds.bsky.test/")).toBe(
      "https://pds.bsky.test",
    );
    // The port of HTTPS, named, is no other port.
    expect(publicOrigin("https://pds.bsky.test:443")).toBe(
      "https://pds.bsky.test",
    );
  });

  it.each([
    "http://bsky.social",
    "https://10.0.0.5",
    "https://10.0.0.5:8443",
    "https://[::1]",
    "https://0x7f.0.0.1",
    "https://2130706433",
    "https://localhost",
    "https://pds.lan",
    "https://bsky.social:8443",
    "https://ada:secret@bsky.social",
    "https://bsky.social#x",
    "javascript:alert(1)",
    "/relative",
  ])("refuse %j", (address) => {
    expect(publicUrl(address)).toBeNull();
    expect(publicOrigin(address)).toBeNull();
  });

  it("refuse what is no string", () => {
    expect(publicUrl(undefined)).toBeNull();
    expect(publicOrigin(42)).toBeNull();
  });

  it("take a server alone for an origin, without a path or a query", () => {
    expect(publicOrigin("https://pds.bsky.test/xrpc")).toBeNull();
    expect(publicOrigin("https://pds.bsky.test/?x=1")).toBeNull();
  });
});
