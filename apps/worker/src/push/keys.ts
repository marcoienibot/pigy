import { isLocal } from "../auth/config.ts";
import type { Bindings } from "../env.ts";
import { toBase64Url, type VapidKey } from "./web-push.ts";

/**
 * The key that pigy signs with as a sender of push messages, RFC 8292: the
 * secret `VAPID_PRIVATE_KEY`. A browser subscribes with its public half,
 * and its push service takes messages for that subscription from this key
 * alone. So the key is not replaced like the others, with an old one kept
 * next to the new: a subscription cannot be moved to another key, and
 * every device has to turn its notifications on again after a change.
 */

/**
 * The key as configured where the app is reached at `origin`. Without the
 * secret it is `developmentKey`, which only builds for development and
 * tests pass, and only where the app is reached locally: like the
 * development key of the vault, it is in the repository.
 */
export function vapidKeyFor(
  env: Bindings,
  developmentKey: string | undefined,
  origin: string,
): string | undefined {
  return (
    env.VAPID_PRIVATE_KEY ?? (isLocal(origin) ? developmentKey : undefined)
  );
}

/**
 * The same for work that no request stands behind: the sending, which the
 * object of a workspace does from its alarm. What it sends goes to
 * subscriptions that a request took, which had the development key only
 * where the app was reached locally: `vaultWithoutRequest` has the same
 * rule.
 */
export function vapidKeyWithoutRequest(
  env: Bindings,
  developmentKey: string | undefined,
): string | undefined {
  return env.VAPID_PRIVATE_KEY ?? developmentKey;
}

/**
 * The key in `configured`: a private key of ECDSA on P-256 in PKCS #8, in
 * base64, which is what `openssl` makes. Throws, without repeating the
 * key, if `configured` is not that.
 */
export async function parseVapidKey(configured: string): Promise<VapidKey> {
  let jwk: JsonWebKey | ArrayBuffer;
  try {
    const bytes = Uint8Array.from(atob(configured.trim()), (char) =>
      char.charCodeAt(0),
    );
    const key = await crypto.subtle.importKey(
      "pkcs8",
      bytes,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign"],
    );
    jwk = await crypto.subtle.exportKey("jwk", key);
  } catch {
    throw new Error(
      "VAPID_PRIVATE_KEY is not a key of P-256 in PKCS #8 and base64",
    );
  }
  const { kty, crv, x, y, d } = jwk instanceof ArrayBuffer ? {} : jwk;
  const point = [x, y].map((coordinate) =>
    Uint8Array.from(
      atob((coordinate ?? "").replaceAll("-", "+").replaceAll("_", "/")),
      (char) => char.charCodeAt(0),
    ),
  );
  if (
    kty !== "EC" ||
    crv !== "P-256" ||
    !x ||
    !y ||
    !d ||
    point.some(({ byteLength }) => byteLength !== 32)
  ) {
    throw new Error("VAPID_PRIVATE_KEY is not a key of P-256");
  }
  const [px, py] = point as [Uint8Array, Uint8Array];
  // The uncompressed point: the byte 4, then the two coordinates.
  const publicKey = new Uint8Array(65);
  publicKey[0] = 4;
  publicKey.set(px, 1);
  publicKey.set(py, 33);
  return {
    privateKey: { kty, crv, x, y, d },
    publicKey: toBase64Url(publicKey),
  };
}

/**
 * The key of this deployment from what is `configured`, or undefined if
 * it has none: nothing is configured, or what is configured is no key,
 * which is logged without it.
 */
export async function vapidKeyOf(
  configured: string | undefined,
): Promise<VapidKey | undefined> {
  if (configured === undefined) return undefined;
  try {
    return await parseVapidKey(configured);
  } catch (error) {
    console.error(
      `No push message can be sent: ${error instanceof Error ? error.message : "VAPID_PRIVATE_KEY is not valid"}.`,
    );
    return undefined;
  }
}
