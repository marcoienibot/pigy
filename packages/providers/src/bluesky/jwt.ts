import { z } from "zod";
import { base64Url, randomToken, sha256 } from "../http.ts";

/**
 * The signed tokens that a client of atproto OAuth makes: the DPoP proof
 * of every request, RFC 9449, and the assertion that a confidential client
 * authenticates with, RFC 7523. Both are JWTs signed with ES256, the one
 * algorithm that every server of atproto takes, and both are written here
 * on the Web Crypto API, which the browser, the Workers runtime and Node
 * have alike. The time in them is the clock that the adapter was made
 * with, never the global one.
 */

/** A private key of ECDSA on P-256, as a JWK. It is a secret. */
export const privateJwkSchema = z.object({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: z.string().min(1),
  y: z.string().min(1),
  d: z.string().min(1),
});

export type PrivateJwk = z.infer<typeof privateJwkSchema>;

/** The public half of a key, as a JWK. */
export type PublicJwk = { kty: "EC"; crv: "P-256"; x: string; y: string };

const algorithm = { name: "ECDSA", namedCurve: "P-256" } as const;

const encoder = new TextEncoder();

const encoded = (value: unknown) =>
  base64Url(encoder.encode(JSON.stringify(value)));

/** The public half of `key`. */
export function publicJwk({ kty, crv, x, y }: PrivateJwk): PublicJwk {
  return { kty, crv, x, y };
}

/** A new key, for the DPoP proofs of one session. */
export async function newKey(): Promise<PrivateJwk> {
  const pair = await crypto.subtle.generateKey(algorithm, true, [
    "sign",
    "verify",
  ]);
  return privateJwkSchema.parse(
    await crypto.subtle.exportKey("jwk", pair.privateKey),
  );
}

/**
 * A JWT with `header` and `claims`, signed with `key`. The Web Crypto API
 * signs ECDSA as the two numbers one after the other, which is the form
 * that JWS takes for ES256.
 */
export async function signJwt(
  key: PrivateJwk,
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
): Promise<string> {
  const input = `${encoded({ ...header, alg: "ES256" })}.${encoded(claims)}`;
  const signing = await crypto.subtle.importKey(
    "jwk",
    { ...key, ext: true },
    algorithm,
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    signing,
    encoder.encode(input),
  );
  return `${input}.${base64Url(signature)}`;
}

const seconds = (time: Date) => Math.floor(time.getTime() / 1000);

/**
 * The DPoP proof of a request: that whoever sends it holds `key`. A server
 * that has handed out a nonce wants it back in the proof, and a request
 * with an access token names the token by its hash.
 */
export async function dpopProof(
  key: PrivateJwk,
  request: {
    method: string;
    url: string;
    now: Date;
    nonce: string | undefined;
    accessToken?: string | undefined;
  },
): Promise<string> {
  const { origin, pathname } = new URL(request.url);
  return signJwt(
    key,
    { typ: "dpop+jwt", jwk: publicJwk(key) },
    {
      // Good once: the server remembers it.
      jti: randomToken(16),
      htm: request.method,
      // Without the query, RFC 9449 section 4.2.
      htu: origin + pathname,
      iat: seconds(request.now),
      ...(request.nonce !== undefined && { nonce: request.nonce }),
      ...(request.accessToken !== undefined && {
        ath: base64Url(await sha256(request.accessToken)),
      }),
    },
  );
}

/** What a confidential client authenticates with. */
export const clientAssertionType =
  "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

/**
 * The assertion that the client `clientId` authenticates with at the
 * authorization server `issuer`, signed with its key `keyId`. It is good
 * once, so every request gets a new one.
 */
export function clientAssertion(
  key: PrivateJwk,
  keyId: string,
  clientId: string,
  issuer: string,
  now: Date,
): Promise<string> {
  const issued = seconds(now);
  return signJwt(
    key,
    { typ: "JWT", kid: keyId },
    {
      iss: clientId,
      sub: clientId,
      aud: issuer,
      jti: randomToken(16),
      iat: issued,
      exp: issued + 60,
    },
  );
}

/** A verifier of PKCE, and the challenge with the method S256. */
export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken();
  return { verifier, challenge: base64Url(await sha256(verifier)) };
}
