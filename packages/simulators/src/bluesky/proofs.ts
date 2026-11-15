import {
  calculateJwkThumbprint,
  decodeProtectedHeader,
  EmbeddedJWK,
  importJWK,
  type JWK,
  jwtVerify,
} from "jose";
import { base64Url } from "../world/encoding.ts";
import type { Client, State } from "./state.ts";

/**
 * What the simulated servers check of the signed proofs that a client
 * sends: the DPoP proof of every request, RFC 9449, and the assertion that
 * a confidential client authenticates with, RFC 7523, both as the "OAuth"
 * specification of atproto requires them. The signatures are checked with
 * the jose library, which the adapter does not use: a proof that the
 * adapter signs by itself is read here by somebody else's code.
 */

// How long a server hands out the same nonce. It takes that one and the
// one before it, so a nonce is good for less than the five minutes that
// the specification allows at most.
const nonceSpanMs = 2 * 60 * 1000;

// How far the time of a proof may be from the clock of the server. GUESS:
// the specification names no window. The reference server allows the
// lifetime of a nonce.
const proofToleranceSeconds = 3 * 60;

// How old the assertion of a client may be. The specification has servers
// take one that is less than a minute old.
const assertionMaxAgeSeconds = 60;

// The longest ID of a proof that is remembered. Longer ones are refused.
const maxJtiLength = 200;

const span = (state: State) =>
  Math.floor(state.world.now().getTime() / nonceSpanMs);

/** The nonce that the server at `host` hands out now. */
export function currentNonce(state: State, host: string): string {
  const key = `${host}/${span(state)}`;
  const known = state.nonces.get(key);
  if (known) return known;
  const nonce = base64Url(crypto.getRandomValues(new Uint8Array(16)));
  state.nonces.put(key, nonce);
  return nonce;
}

function isCurrentNonce(state: State, host: string, nonce: string): boolean {
  const now = span(state);
  return [now, now - 1].some(
    (candidate) => state.nonces.get(`${host}/${candidate}`) === nonce,
  );
}

/**
 * Notes that the ID of a proof was used, and returns whether it was new.
 * An ID is remembered for as long as its proof could be sent again.
 */
function isFirstUse(state: State, kind: string, jti: string): boolean {
  const key = `${kind}/${jti}`;
  const now = state.world.now().getTime();
  const until = state.replays.get(key);
  if (until !== undefined && until > now) return false;
  state.replays.put(key, now + 2 * proofToleranceSeconds * 1000);
  return true;
}

/** A proof that held up: the key that signed it, by its thumbprint. */
export type Proof = { jkt: string };

/** Why a proof did not hold up, in the terms of RFC 9449. */
export type ProofFailure = {
  error: "use_dpop_nonce" | "invalid_dpop_proof";
  description: string;
};

/**
 * Checks the DPoP proof of `request`, which was sent to the server at
 * `host`. With `accessToken`, the proof has to be for that token.
 * Returns null for a request without a proof.
 */
export async function checkProof(
  state: State,
  host: string,
  request: Request,
  accessToken?: string,
): Promise<Proof | ProofFailure | null> {
  const invalid = (description: string): ProofFailure => ({
    error: "invalid_dpop_proof",
    description,
  });
  const header = request.headers.get("DPoP");
  if (header === null) return null;
  // Two headers arrive as one value with a comma.
  if (header === "" || header.includes(",")) {
    return invalid("DPoP header must contain a single proof");
  }

  let verified: Awaited<ReturnType<typeof jwtVerify>>;
  try {
    verified = await jwtVerify(header, EmbeddedJWK, {
      typ: "dpop+jwt",
      // ES256 is the one algorithm that every server must take, and the
      // only one that is simulated.
      algorithms: ["ES256"],
      currentDate: state.world.now(),
      // Requires the time of issue, and that it is close to now.
      maxTokenAge: proofToleranceSeconds,
      clockTolerance: proofToleranceSeconds,
    });
  } catch (error) {
    return invalid(
      `Failed to verify DPoP proof: ${error instanceof Error ? error.message : "unreadable"}`,
    );
  }
  const { payload, protectedHeader } = verified;
  const jwk = protectedHeader.jwk as JWK;
  // A proof carries the public half of its key and nothing else.
  if ("d" in jwk) return invalid("DPoP proof must not carry a private key");

  const { jti, htm, htu, nonce, ath } = payload;
  if (typeof jti !== "string" || jti === "" || jti.length > maxJtiLength) {
    return invalid('DPoP "jti" missing');
  }
  if (htm !== request.method) return invalid('DPoP "htm" mismatch');
  const url = new URL(request.url);
  let target: URL;
  try {
    target = new URL(typeof htu === "string" ? htu : "");
  } catch {
    return invalid('DPoP "htu" is not a valid URL');
  }
  // Compared without query and fragment, as RFC 9449 has it.
  if (target.origin + target.pathname !== url.origin + url.pathname) {
    return invalid('DPoP "htu" mismatch');
  }
  if (nonce !== undefined && typeof nonce !== "string") {
    return invalid('Invalid DPoP "nonce" type');
  }
  // A nonce of the server's own is mandatory in atproto. The client learns
  // it from this refusal.
  if (nonce === undefined) {
    return {
      error: "use_dpop_nonce",
      description: "Authorization server requires nonce in DPoP proof",
    };
  }
  if (!isCurrentNonce(state, host, nonce)) {
    return { error: "use_dpop_nonce", description: 'DPoP "nonce" mismatch' };
  }
  if (accessToken !== undefined) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(accessToken),
    );
    if (ath !== base64Url(digest)) return invalid('DPoP "ath" mismatch');
  } else if (ath !== undefined) {
    return invalid('DPoP "ath" claim not allowed');
  }
  // Last, so that a proof which is refused for its nonce can be sent again
  // with one. A proof is good once.
  if (!isFirstUse(state, `dpop/${host}`, jti)) {
    return invalid('DPoP "jti" was used before');
  }
  return { jkt: await calculateJwkThumbprint(jwk, "sha256") };
}

/** The key that a client authenticated with. */
export type ClientAuth = { kid: string; jkt: string };

export const assertionType =
  "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

/**
 * Checks the assertion that `client` authenticates with at the
 * authorization server `issuer`: a JWT that one of the keys which the
 * client publishes has signed. Returns why not, if it does not hold up.
 */
export async function checkAssertion(
  state: State,
  issuer: string,
  client: Client,
  params: Record<string, string>,
): Promise<ClientAuth | string> {
  if (params.client_assertion_type !== assertionType) {
    return "client_assertion_type must be the JWT bearer type";
  }
  const assertion = params.client_assertion;
  if (!assertion) return "client_assertion is missing";

  let kid: unknown;
  try {
    ({ kid } = decodeProtectedHeader(assertion));
  } catch {
    return "client_assertion is not a JWT";
  }
  if (typeof kid !== "string" || kid === "") {
    return 'client_assertion has no "kid"';
  }
  const jwk = client.keys.find((key) => key.kid === kid) as JWK | undefined;
  if (!jwk) return `The client publishes no key "${kid}"`;

  let claims: Awaited<ReturnType<typeof jwtVerify>>["payload"];
  try {
    ({ payload: claims } = await jwtVerify(
      assertion,
      await importJWK(jwk, "ES256"),
      {
        algorithms: ["ES256"],
        issuer: client.id,
        subject: client.id,
        audience: issuer,
        currentDate: state.world.now(),
        maxTokenAge: assertionMaxAgeSeconds,
        // RFC 7523 section 3: the JWT must contain an "exp", and the
        // server rejects one that has expired. The age above requires an
        // "iat" as well.
        requiredClaims: ["exp"],
        clockTolerance: 10,
      },
    ));
  } catch (error) {
    return `client_assertion did not verify: ${error instanceof Error ? error.message : "unreadable"}`;
  }
  const { jti } = claims;
  if (typeof jti !== "string" || jti === "" || jti.length > maxJtiLength) {
    return 'client_assertion has no "jti"';
  }
  if (!isFirstUse(state, `assertion/${client.id}`, jti)) {
    return 'client_assertion "jti" was used before';
  }
  return { kid, jkt: await calculateJwkThumbprint(jwk, "sha256") };
}
