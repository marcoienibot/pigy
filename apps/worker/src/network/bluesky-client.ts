import { connectCallbackPath } from "@pigy/core";
import { type BlueskyClientKey, clientMetadata } from "@pigy/providers/bluesky";
import { Hono } from "hono";
import { isLocal } from "../auth/config.ts";
import type { AppDependencies, AppEnv, Bindings } from "../env.ts";
import { handleNotFound } from "../errors.ts";

/**
 * pigy as a client of Bluesky. atproto OAuth has no registration: a client
 * is the address of a document that describes it, its client metadata,
 * which an authorization server reads when somebody connects an account.
 * pigy serves it here, at its own address, so that every pigy is a client
 * of its own and nothing has to be set up at Bluesky.
 *
 * pigy is a confidential client: it signs what it sends to the
 * authorization server with a key of its own, whose public half the
 * document holds. The keys are the secret `BLUESKY_CLIENT_KEYS`.
 */

/** Where pigy serves its client metadata. Its address is the client ID. */
export const blueskyClientMetadataPath =
  "/connect/bluesky/client-metadata.json";

/**
 * pigy's client ID for the callback address `redirectUri`: the address of
 * its client metadata at the same origin. A client ID is an address, so a
 * pigy that moves to another address is another client, and its accounts
 * have to be connected again: PLAN.md section 20.
 */
export function blueskyClientIdFor(redirectUri: string): string {
  return new URL(blueskyClientMetadataPath, redirectUri).href;
}

/**
 * The keys that pigy signs with as a client of Bluesky where the app is
 * reached at `origin`, as configured: `BLUESKY_CLIENT_KEYS`. Without it,
 * the key of `developmentKeys`, which only builds for development and
 * tests pass, and only where the app is reached locally: like the
 * development key of the vault, it is in the repository.
 */
export function blueskyKeysFor(
  env: Bindings,
  developmentKeys: string | undefined,
  origin: string,
): string | undefined {
  return (
    env.BLUESKY_CLIENT_KEYS ?? (isLocal(origin) ? developmentKeys : undefined)
  );
}

/**
 * The same for work that no request stands behind, such as a step of the
 * publishing workflow that renews an access. What it signs is for a
 * session that a request began, which had the development key only where
 * the app was reached locally: `vaultWithoutRequest` has the same rule.
 */
export function blueskyKeysWithoutRequest(
  env: Bindings,
  developmentKeys: string | undefined,
): string | undefined {
  return env.BLUESKY_CLIENT_KEYS ?? developmentKeys;
}

/**
 * The keys in `configured`: a comma-separated list of "<version>:<key>",
 * each key a private key of ECDSA on P-256 in PKCS #8, in base64. The key
 * with the highest version comes first: it signs the sessions that begin.
 * The others stay for the sessions that began with them, which are bound
 * to the key that they began with. Throws, without repeating a key, if
 * `configured` is not that.
 */
export async function parseBlueskyClientKeys(
  configured: string,
): Promise<BlueskyClientKey[]> {
  const keys: { version: number; key: BlueskyClientKey }[] = [];
  for (const [index, entry] of configured.split(",").entries()) {
    const where = `Entry ${index + 1} of BLUESKY_CLIENT_KEYS`;
    const match = /^\s*(\d+):(\S+)\s*$/.exec(entry);
    if (!match) throw new Error(`${where} is not "<version>:<key>"`);
    const version = Number(match[1]);
    if (keys.some((other) => other.version === version)) {
      throw new Error(`Version ${version} is in BLUESKY_CLIENT_KEYS twice`);
    }
    let jwk: JsonWebKey | ArrayBuffer;
    try {
      const bytes = Uint8Array.from(atob(match[2] ?? ""), (char) =>
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
        `The key of version ${version} in BLUESKY_CLIENT_KEYS is not a key of P-256 in PKCS #8 and base64`,
      );
    }
    const { kty, crv, x, y, d } = jwk instanceof ArrayBuffer ? {} : jwk;
    if (kty !== "EC" || crv !== "P-256" || !x || !y || !d) {
      throw new Error(
        `The key of version ${version} in BLUESKY_CLIENT_KEYS is not a key of P-256`,
      );
    }
    keys.push({
      version,
      key: { id: `pigy-${version}`, privateKey: { kty, crv, x, y, d } },
    });
  }
  return keys.sort((a, b) => b.version - a.version).map(({ key }) => key);
}

/**
 * The client metadata of the pigy at `origin`, with the public halves of
 * the keys in `configured`.
 */
export async function pigyClientMetadata(origin: string, configured: string) {
  return clientMetadata({
    clientId: origin + blueskyClientMetadataPath,
    redirectUri: origin + connectCallbackPath("bluesky"),
    name: "pigy",
    keys: await parseBlueskyClientKeys(configured),
  });
}

/** Under `/connect`: the client metadata, for Bluesky to read. */
export function blueskyClientRoutes({
  developmentBlueskyClientKeys,
}: AppDependencies): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get(blueskyClientMetadataPath.slice("/connect".length), async (c) => {
    const { origin } = new URL(c.req.url);
    const configured = blueskyKeysFor(
      c.env,
      developmentBlueskyClientKeys,
      origin,
    );
    // A pigy without keys is no client of Bluesky.
    if (configured === undefined) return handleNotFound(c);
    return c.json(await pigyClientMetadata(origin, configured));
  });
  return app;
}
