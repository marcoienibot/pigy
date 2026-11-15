import type { BlueskyClientKey } from "../src/bluesky/index.ts";

/** A new key for pigy's client, as the Worker has one in its secrets. */
export async function newClientKey(id: string): Promise<BlueskyClientKey> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const { kty, crv, x, y, d } = await crypto.subtle.exportKey(
    "jwk",
    pair.privateKey,
  );
  if (kty !== "EC" || crv !== "P-256" || !x || !y || !d) {
    throw new Error("Not a key of P-256");
  }
  return { id, privateKey: { kty, crv, x, y, d } };
}
