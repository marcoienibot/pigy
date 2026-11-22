import { type Clock, type Fetch, fromBase64Url, toBase64Url } from "@pigy/core";

/**
 * Web Push from the Worker: a message to one browser, through the push
 * service that the browser has named. Three standards, written here on the
 * Web Crypto API, which the Workers runtime has, without a library:
 *
 * - RFC 8030 is the request: a POST to the endpoint of the subscription,
 *   with how long the service is to keep the message, `TTL`.
 * - RFC 8291 encrypts the message for the browser, so that the push service
 *   carries what it cannot read, in the encoding `aes128gcm` of RFC 8188.
 * - RFC 8292, VAPID, says who sends: a token that is signed with the key
 *   which the browser was given when it subscribed.
 *
 * `fetch` and the clock are parameters, as for everything that talks to
 * somebody else. The endpoint is an address that a browser has named: it
 * is checked where a subscription is taken, `pushEndpoint`, and nothing
 * here sends to one that did not pass.
 */

/** What a browser hands out when it subscribes: `PushSubscription.toJSON()`. */
export type PushTarget = {
  /** Where the push service takes messages for the browser. */
  endpoint: string;
  /** The public key of the browser: 65 bytes of P-256, in base64url. */
  p256dh: string;
  /** The secret that the browser shares with pigy: 16 bytes, in base64url. */
  auth: string;
};

/** The key that pigy signs with as a sender, RFC 8292. It is a secret. */
export type VapidKey = {
  /** A private key of ECDSA on P-256, as a JWK. */
  privateKey: { kty: "EC"; crv: "P-256"; x: string; y: string; d: string };
  /**
   * Its public half as browsers and push services take it: the 65 bytes of
   * the uncompressed point, in base64url. It is what a page subscribes
   * with, `applicationServerKey`.
   */
  publicKey: string;
};

/** How the push service is to treat a message. */
export type PushOptions = {
  /** For how many seconds the service keeps a message that it cannot deliver. */
  ttlSeconds: number;
  /**
   * Names what the message is about, RFC 8030 section 5.4: a message that
   * waits at the service is replaced by a later one of the same topic. At
   * most 32 characters of the alphabet of base64url.
   */
  topic?: string;
  /** Who a push service can turn to about the sender: an address. */
  subject: string;
};

/**
 * What became of a message:
 *
 * - `sent`: the service has taken it.
 * - `gone`: the service says that the subscription is no more, with 404 or
 *   410. It never comes back, so whoever keeps it deletes it.
 * - `refused`: the service did not take the message, and the subscription
 *   may still be good: it has too much to do, the message is too large, or
 *   it refuses the sender. `status` is what it answered.
 * - `unreachable`: no answer came.
 */
export type PushOutcome =
  | { outcome: "sent" }
  | { outcome: "gone" }
  | { outcome: "refused"; status: number }
  | { outcome: "unreachable" };

/**
 * The largest message that a push service has to take, RFC 8030 section
 * 7.2: 4096 bytes, with everything that the encryption adds.
 */
export const maxPushBytes = 4096;

/** The record size that goes into the header of a message, RFC 8188. */
const recordSize = 4096;

/** How long a token of the sender is good for, in seconds: half a day. */
const tokenLifetimeSeconds = 12 * 60 * 60;

/** How long the push service is given to answer, in milliseconds. */
const answerWithinMs = 10_000;

const encoder = new TextEncoder();

type Bytes = Uint8Array<ArrayBuffer>;

const bytesOf = (text: string): Bytes => new Uint8Array(encoder.encode(text));

function concat(...parts: Uint8Array[]): Bytes {
  const all = new Uint8Array(
    parts.reduce((length, part) => length + part.byteLength, 0),
  );
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.byteLength;
  }
  return all;
}

/** HKDF with SHA-256, RFC 5869: both of its steps. */
async function hkdf(
  salt: Bytes,
  secret: Bytes,
  info: Bytes,
  length: number,
): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", secret, "HKDF", false, [
    "deriveBits",
  ]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info },
      key,
      length * 8,
    ),
  );
}

/**
 * What `encryptPush` takes besides the message, and what a test puts in
 * the place of what is random: RFC 8291 has an example with both given.
 */
export type PushSecrets = {
  /** 16 random bytes, new for every message. */
  salt: Bytes;
  /** A key pair of ECDH on P-256, new for every message. */
  keys: CryptoKeyPair;
};

async function newSecrets(): Promise<PushSecrets> {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  // A pair, for ECDH: the Workers runtime types it as either.
  if (!("privateKey" in keys)) throw new Error("ECDH made no key pair");
  return { salt: crypto.getRandomValues(new Uint8Array(16)), keys };
}

/**
 * `message` encrypted for the browser of `target`, as the body of a
 * request to its push service: RFC 8291, in the encoding `aes128gcm`.
 * Returns undefined if the keys of the target are not what a browser hands
 * out: nothing can be encrypted for them.
 */
export async function encryptPush(
  target: Pick<PushTarget, "p256dh" | "auth">,
  message: Uint8Array,
  secrets?: PushSecrets,
): Promise<Bytes | undefined> {
  const browserKey = fromBase64Url(target.p256dh);
  const authSecret = fromBase64Url(target.auth);
  if (browserKey?.byteLength !== 65 || authSecret?.byteLength !== 16) {
    return undefined;
  }
  let browser: CryptoKey;
  try {
    browser = await crypto.subtle.importKey(
      "raw",
      browserKey,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
  } catch {
    // 65 bytes that are no point of the curve.
    return undefined;
  }
  const { salt, keys } = secrets ?? (await newSecrets());
  const senderKey = new Uint8Array(
    (await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer,
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      // The types of the Workers runtime call the other key `$public`.
      // The runtime takes it under the name that the standard has.
      {
        name: "ECDH",
        public: browser,
      } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      keys.privateKey,
      256,
    ),
  );
  // RFC 8291 section 3.4: the secret of the two keys is mixed with the one
  // that the browser handed out, and with both public keys.
  const input = await hkdf(
    authSecret,
    shared,
    concat(bytesOf("WebPush: info\0"), browserKey, senderKey),
    32,
  );
  // RFC 8188 section 2.2 and 2.3: the key and the nonce of the one record.
  const key = await hkdf(
    salt,
    input,
    bytesOf("Content-Encoding: aes128gcm\0"),
    16,
  );
  const nonce = await hkdf(
    salt,
    input,
    bytesOf("Content-Encoding: nonce\0"),
    12,
  );
  const cipher = await crypto.subtle.importKey("raw", key, "AES-GCM", false, [
    "encrypt",
  ]);
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    cipher,
    // The byte 2 ends the last record, which this one is.
    concat(message, Uint8Array.of(2)),
  );
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, recordSize);
  // The header of RFC 8188, with the key of the sender as its key ID.
  return concat(
    salt,
    size,
    Uint8Array.of(senderKey.byteLength),
    senderKey,
    new Uint8Array(sealed),
  );
}

/**
 * What a sender says who it is with, RFC 8292: the value of
 * `Authorization` for a request to the push service at `audience`.
 */
export async function vapidAuthorization(
  key: VapidKey,
  audience: string,
  subject: string,
  now: Clock,
): Promise<string> {
  const encoded = (value: unknown) =>
    toBase64Url(encoder.encode(JSON.stringify(value)));
  const input = `${encoded({ typ: "JWT", alg: "ES256" })}.${encoded({
    aud: audience,
    exp: Math.floor(now().getTime() / 1000) + tokenLifetimeSeconds,
    sub: subject,
  })}`;
  const signing = await crypto.subtle.importKey(
    "jwk",
    { ...key.privateKey, ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  // The Web Crypto API signs ECDSA as the two numbers one after the other,
  // which is the form that JWS takes for ES256.
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    signing,
    encoder.encode(input),
  );
  return `vapid t=${input}.${toBase64Url(signature)}, k=${key.publicKey}`;
}

/**
 * Sends `message` to the browser of `target` and says what became of it.
 * It does not throw for anything that a push service or a subscription
 * does: only for what is no failure of a network, which `fetch` passes on
 * as it is.
 *
 * A message that is too large for a push service to take is not sent:
 * that is a mistake of the caller's, and throws.
 */
export async function sendPush(
  { fetch, now }: { fetch: Fetch; now: Clock },
  key: VapidKey,
  target: PushTarget,
  message: Uint8Array,
  { ttlSeconds, topic, subject }: PushOptions,
): Promise<PushOutcome> {
  const body = await encryptPush(target, message);
  // Keys that nothing can be encrypted for are no subscription.
  if (!body) return { outcome: "gone" };
  if (body.byteLength > maxPushBytes) {
    throw new Error(
      `A push message of ${body.byteLength} bytes is larger than a push service takes`,
    );
  }
  // A timer that is called off when the answer is in, and not
  // `AbortSignal.timeout`: this runs in the object of a workspace, which
  // the runtime keeps busy for as long as a timer of its is pending.
  const waiting = new AbortController();
  const late = setTimeout(() => waiting.abort(), answerWithinMs);
  let response: Response;
  try {
    response = await fetch(target.endpoint, {
      method: "POST",
      headers: {
        Authorization: await vapidAuthorization(
          key,
          new URL(target.endpoint).origin,
          subject,
          now,
        ),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(ttlSeconds),
        Urgency: "normal",
        ...(topic !== undefined && { Topic: topic }),
      },
      body,
      // A push service sends nobody on, and a redirect would carry the
      // message to a host that nobody has checked.
      redirect: "manual",
      signal: waiting.signal,
    });
  } catch (error) {
    // What a `fetch` fails with when no answer comes, and a request whose
    // time is up. Anything else is not the network's.
    if (error instanceof TypeError || waiting.signal.aborted) {
      return { outcome: "unreachable" };
    }
    throw error;
  } finally {
    clearTimeout(late);
  }
  // Nothing of the answer is read: its status says it all.
  await response.body?.cancel();
  if (response.status >= 200 && response.status < 300) {
    return { outcome: "sent" };
  }
  if (response.status === 404 || response.status === 410) {
    return { outcome: "gone" };
  }
  return { outcome: "refused", status: response.status };
}
