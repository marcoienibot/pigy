import { isLocal } from "./auth/config.ts";
import type { Bindings } from "./env.ts";

/**
 * Seals what pigy keeps of other people's secrets before it is stored: the
 * credentials of a channel, pigy's registration with a Mastodon instance,
 * and what a connection that has begun needs to finish. Sealed, a value is
 * of no use to somebody who reads the database and does not have the key,
 * which is a secret of the Worker and is stored nowhere else.
 *
 * AES-256-GCM of the Web Crypto API, with a new random nonce for every
 * value. The cipher is authenticated: a sealed value that was changed, or
 * that is opened with another key, fails to open instead of opening as
 * something else. Every value is sealed for a context, which says what it
 * is and where it belongs, such as the workspace and account of a channel.
 * It opens only under the same context, so a sealed value that is copied
 * to another row is worthless there.
 *
 * A sealed value is text: "<key version>.<nonce>.<ciphertext>", the last
 * two in base64. The version says which key opens it, which is what lets
 * the key be replaced: see `CREDENTIAL_KEYS` in env.ts.
 */
export type Vault = {
  /** Seals `value`, which must survive `JSON.stringify`, for `context`. */
  seal(context: readonly string[], value: unknown): Promise<string>;
  /**
   * The value that was sealed for `context`. Throws a `VaultError` if
   * `sealed` is not that: it was sealed for another context or with a key
   * that is not configured, or it is not a sealed value at all.
   */
  open(context: readonly string[], sealed: string): Promise<unknown>;
};

/** A sealed value could not be opened. The message holds no secret. */
export class VaultError extends Error {}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// What AES-256 takes.
const keyLength = 32;
// What AES-GCM is specified for.
const nonceLength = 12;

function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The bytes that `text` stands for, or undefined if it is not base64. */
function fromBase64(text: string): Uint8Array<ArrayBuffer> | undefined {
  try {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
}

type Keys = Map<number, Uint8Array<ArrayBuffer>>;

/**
 * The keys in `text`, by their version, or a description of what is wrong
 * with it. The description never repeats a key.
 */
function parseKeys(text: string): Keys | string {
  const keys: Keys = new Map();
  for (const [index, entry] of text.split(",").entries()) {
    const where = `Entry ${index + 1}`;
    const match = /^\s*(\d+):(\S+)\s*$/.exec(entry);
    if (!match) return `${where} is not "<version>:<key>"`;
    const version = Number(match[1]);
    const key = fromBase64(match[2] ?? "");
    if (!Number.isSafeInteger(version)) return `${where} has no usable version`;
    if (keys.has(version)) return `Version ${version} is there twice`;
    if (key?.byteLength !== keyLength) {
      return `The key of version ${version} is not ${keyLength} bytes in base64`;
    }
    keys.set(version, key);
  }
  return keys;
}

/**
 * A vault with the keys in `configured`: a comma-separated list of
 * "<version>:<key>", each key 32 bytes in base64. The key with the highest
 * version seals. All of them open, each what was sealed with it. Returns a
 * description of what is wrong with `configured` if it is not that.
 */
export function createVault(configured: string): Vault | string {
  const keys = parseKeys(configured);
  if (typeof keys === "string") return keys;
  const newest = Math.max(...keys.keys());

  const cipher = (version: number, nonce: Uint8Array<ArrayBuffer>) => {
    const key = keys.get(version);
    if (!key) throw new VaultError(`There is no key of version ${version}`);
    return {
      key: crypto.subtle.importKey("raw", key, "AES-GCM", false, [
        "encrypt",
        "decrypt",
      ]),
      algorithm: (context: readonly string[]) => ({
        name: "AES-GCM",
        iv: nonce,
        // JSON, so that no two lists of texts make the same bytes.
        additionalData: encoder.encode(JSON.stringify(context)),
      }),
    };
  };

  return {
    async seal(context, value) {
      const nonce = crypto.getRandomValues(new Uint8Array(nonceLength));
      const { key, algorithm } = cipher(newest, nonce);
      const sealed = await crypto.subtle.encrypt(
        algorithm(context),
        await key,
        encoder.encode(JSON.stringify(value)),
      );
      return `${newest}.${toBase64(nonce)}.${toBase64(sealed)}`;
    },

    async open(context, sealed) {
      const [version, nonce, ciphertext, ...rest] = sealed.split(".");
      const nonceBytes = fromBase64(nonce ?? "");
      const cipherBytes = fromBase64(ciphertext ?? "");
      if (
        !/^\d+$/.test(version ?? "") ||
        nonceBytes?.byteLength !== nonceLength ||
        !cipherBytes ||
        rest.length > 0
      ) {
        throw new VaultError("This is not a sealed value");
      }
      const { key, algorithm } = cipher(Number(version), nonceBytes);
      let opened: ArrayBuffer;
      try {
        opened = await crypto.subtle.decrypt(
          algorithm(context),
          await key,
          cipherBytes,
        );
      } catch {
        throw new VaultError(
          "The value was not sealed with this key and for this place",
        );
      }
      return JSON.parse(decoder.decode(opened));
    },
  };
}

/**
 * The vault of this deployment for one request, or undefined if it has
 * none. Then nothing can be sealed, and whatever needs sealing is refused:
 * nothing is ever stored in the clear instead.
 *
 * The keys are those of `CREDENTIAL_KEYS`. Without that variable they are
 * `developmentKeys`, which only builds for development and tests pass, and
 * only where the app is reached locally, at `origin`: the key in them is in
 * the repository, so what it seals is as good as in the clear.
 */
export function vaultFor(
  env: Bindings,
  developmentKeys: string | undefined,
  origin: string,
): Vault | undefined {
  return vaultWith(
    env.CREDENTIAL_KEYS ?? (isLocal(origin) ? developmentKeys : undefined),
  );
}

/**
 * The vault of this deployment for work that no request stands behind,
 * such as a step of the publishing workflow, or undefined if it has none.
 *
 * Such work is reached at no address, so there is none to go by: without
 * `CREDENTIAL_KEYS`, the keys are `developmentKeys` wherever the build has
 * them. What that opens was sealed by a request, which was only given the
 * key where the app was reached locally, and what it seals takes the place
 * of something that the same key sealed.
 */
export function vaultWithoutRequest(
  env: Bindings,
  developmentKeys: string | undefined,
): Vault | undefined {
  return vaultWith(env.CREDENTIAL_KEYS ?? developmentKeys);
}

function vaultWith(configured: string | undefined): Vault | undefined {
  if (configured === undefined) {
    console.error(
      "Nothing can be sealed or opened, so no account can be connected or posted to: CREDENTIAL_KEYS is not set.",
    );
    return undefined;
  }
  const vault = createVault(configured);
  if (typeof vault === "string") {
    console.error(
      `Nothing can be sealed or opened, so no account can be connected or posted to: CREDENTIAL_KEYS is not valid. ${vault}.`,
    );
    return undefined;
  }
  return vault;
}
