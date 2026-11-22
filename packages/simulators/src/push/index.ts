import type { Clock, Fetch } from "@pigy/core";
import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import { base64Url } from "../world/encoding.ts";

/**
 * A simulation of the push services of the browsers, and of the browsers
 * behind them: where a server sends a Web Push message, and what the
 * device makes of it. Written from the standards, which is all that a
 * push service promises a sender:
 *
 * - RFC 8030, "Generic Event Delivery Using HTTP Push": the request, its
 *   headers `TTL`, `Urgency` and `Topic`, and the answers.
 * - RFC 8292, "VAPID": who sends, as a signed token.
 * - RFC 8291, "Message Encryption for Web Push", in the encoding
 *   `aes128gcm` of RFC 8188: what the browser decrypts.
 *
 * It answers on the hosts of the real push services, so the code under
 * test is the code that sends to them, and it holds the private key of
 * every device that it has made up: it decrypts what it is sent as the
 * browser would, and keeps what the browser would have been handed. A
 * push service cannot do that. So a message that does not decrypt is
 * taken, with 201, as a real service takes it, and is kept as one that
 * its device could not read.
 *
 * For development and tests only: nothing of it is part of a production
 * build. It shares no code with what sends: the token is checked with
 * `jose`, and the keys of a message are derived step by step with HMAC,
 * where the sender uses the HKDF of the Web Crypto API.
 */

/** The hosts of the push services of Chrome, Firefox and Safari. */
export const pushHosts = [
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
] as const;

/** The largest message that a push service has to take, RFC 8030 7.2. */
const maxBytes = 4096;

/** The longest that a token of a sender may be good for, RFC 8292 2. */
const maxTokenLifetimeSeconds = 24 * 60 * 60;

/** What every address of a simulated device has in it: it is no real one. */
const marker = "pigy-sim-";

/** What a browser hands out when it subscribes. */
export type SimulatedSubscription = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

/** A message as its device got it. */
export type ReceivedPush = {
  /**
   * What the device decrypted, as text. Undefined for a message that it
   * could not read: `unreadable` says why. A browser drops such a message
   * without a word.
   */
  payload: string | undefined;
  unreadable: string | undefined;
  /** The headers that the sender set, as RFC 8030 has them. */
  ttl: number;
  urgency: string;
  topic: string | undefined;
  /** The claims of the sender's token, RFC 8292. */
  sender: { aud: string; exp: number; sub: string };
  receivedAt: number;
};

/** What a push service can be made to do to the next request. */
export const pushFaultKinds = [
  /** It answers 429, with the time to wait. */
  "rate-limit",
  /** It fails, with 500. */
  "server-error",
  /** It takes the message, and its answer never arrives. */
  "lost-response",
] as const;

export type PushFaultKind = (typeof pushFaultKinds)[number];

type Device = {
  /** The key that the page subscribed with: the sender's, in base64url. */
  applicationServerKey: string;
  privateKey: CryptoKey;
  publicKey: Uint8Array<ArrayBuffer>;
  auth: Uint8Array<ArrayBuffer>;
  /** False once the browser has unsubscribed, or the service has dropped it. */
  subscribed: boolean;
  received: ReceivedPush[];
};

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

type Bytes = Uint8Array<ArrayBuffer>;

function fromBase64Url(text: string): Bytes | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined;
  try {
    return Uint8Array.from(
      atob(text.replaceAll("-", "+").replaceAll("_", "/")),
      (char) => char.charCodeAt(0),
    );
  } catch {
    return undefined;
  }
}

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

async function hmac(key: Bytes, data: Bytes): Promise<Bytes> {
  const imported = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, data));
}

/**
 * HKDF of RFC 5869 for an output of at most one block of SHA-256, which is
 * all that RFC 8291 asks for: extract, then the first step of expand.
 */
async function hkdf(
  salt: Bytes,
  secret: Bytes,
  info: Bytes,
  length: number,
): Promise<Bytes> {
  const prk = await hmac(salt, secret);
  return (await hmac(prk, concat(info, Uint8Array.of(1)))).slice(0, length);
}

/** A problem with a request, as the service answers it. */
class Refusal {
  constructor(
    readonly status: number,
    readonly reason: string,
    readonly headers: Record<string, string> = {},
  ) {}
}

function refuse(
  status: number,
  reason: string,
  headers?: Record<string, string>,
): never {
  throw new Refusal(status, reason, headers);
}

/**
 * The parameters of `Authorization: vapid t=…, k=…`, RFC 8292 section 3.
 */
function vapidParameters(header: string | null): { t: string; k: string } {
  if (header === null) refuse(401, "The request has no Authorization");
  const match = /^vapid\s+(.*)$/i.exec(header.trim());
  if (!match) refuse(401, "The Authorization is not of the scheme vapid");
  const parameters = new Map<string, string>();
  for (const pair of (match[1] ?? "").split(",")) {
    const [name, ...value] = pair.trim().split("=");
    if (!name || value.length === 0) {
      refuse(401, "The Authorization is malformed");
    }
    if (parameters.has(name)) refuse(401, `The Authorization has two ${name}`);
    parameters.set(name, value.join("="));
  }
  const t = parameters.get("t");
  const k = parameters.get("k");
  if (!t || !k) refuse(401, "The Authorization lacks t or k");
  return { t, k };
}

export type PushSimulator = {
  /** Answers on the hosts of the push services, and fails for every other. */
  fetch: Fetch;
  /** Whether `host` is one of a push service. */
  owns(host: string): boolean;
  /**
   * Makes up a device and subscribes it, as a page does with
   * `pushManager.subscribe`: `applicationServerKey` is the public key of
   * the sender, in base64url. `host` is the push service of its browser.
   */
  subscribe(options: {
    applicationServerKey: string;
    host?: (typeof pushHosts)[number];
    /**
     * The keys of the device, where a test names them: the private key of
     * the browser as a JWK, and its secret in base64url. They are made up
     * otherwise, as a browser makes them.
     */
    device?: { privateKey: JsonWebKey; auth: string };
  }): Promise<SimulatedSubscription>;
  /**
   * Ends a subscription, as a browser does when the person turns
   * notifications off for the site, or the service when it drops a device
   * that it has not seen for long. A message for it is answered with 410.
   */
  unsubscribe(endpoint: string): void;
  /** What the device with this endpoint has received, the first first. */
  received(endpoint: string): ReceivedPush[];
  /** Makes the next request to any push service fail in this way. */
  arm(kind: PushFaultKind): void;
};

export function createPushSimulator({ now }: { now: Clock }): PushSimulator {
  const devices = new Map<string, Device>();
  const faults: PushFaultKind[] = [];
  const owns = (host: string) =>
    (pushHosts as readonly string[]).includes(host);

  /**
   * Checks the token of the sender, RFC 8292, for a request to `origin`
   * about `device`, and returns its claims.
   */
  async function sender(
    authorization: string | null,
    origin: string,
    device: Device,
  ): Promise<ReceivedPush["sender"]> {
    const { t, k } = vapidParameters(authorization);
    const key = fromBase64Url(k);
    if (key?.byteLength !== 65 || key[0] !== 4) {
      refuse(401, "k is not a public key of P-256");
    }
    // RFC 8292 section 4.2: a subscription that was made with a key takes
    // messages from that key alone.
    if (k !== device.applicationServerKey) {
      refuse(403, "The subscription was made with another key");
    }
    let claims: Record<string, unknown>;
    try {
      if (decodeProtectedHeader(t).alg !== "ES256") {
        refuse(401, "The token is not signed with ES256");
      }
      const verifying = await importJWK(
        {
          kty: "EC",
          crv: "P-256",
          x: base64Url(key.slice(1, 33)),
          y: base64Url(key.slice(33)),
        },
        "ES256",
      );
      ({ payload: claims } = await jwtVerify(t, verifying, {
        algorithms: ["ES256"],
        currentDate: now(),
        // An `exp` that has passed is refused here, with no leeway.
        clockTolerance: 0,
      }));
    } catch (error) {
      if (error instanceof Refusal) throw error;
      // GUESS: the status. RFC 8292 says that a token must be checked and
      // not what a service answers one that does not pass.
      refuse(403, "The token of the sender does not verify");
    }
    const { aud, exp, sub } = claims;
    if (aud !== origin) {
      refuse(403, "aud is not the origin of this push service");
    }
    if (typeof exp !== "number") refuse(403, "The token has no exp");
    if (exp - now().getTime() / 1000 > maxTokenLifetimeSeconds) {
      // RFC 8292 section 2: "MUST NOT be more than 24 hours", and a
      // service may answer 400.
      refuse(400, "exp is more than 24 hours away");
    }
    // RFC 8292 has `sub` as something a sender SHOULD send. The services
    // of Firefox and Safari refuse a token without a contact, so this one
    // does (GUESS: the status).
    if (
      typeof sub !== "string" ||
      !(sub.startsWith("mailto:") || sub.startsWith("https://"))
    ) {
      refuse(403, "sub is not a mailto: or an https: address");
    }
    return { aud, exp, sub };
  }

  /**
   * Decrypts `body` as the browser of `device` does, RFC 8291, and returns
   * the text, or why it cannot be read.
   */
  async function decrypted(
    device: Device,
    body: Bytes,
  ): Promise<Pick<ReceivedPush, "payload" | "unreadable">> {
    const unreadable = (why: string) => ({
      payload: undefined,
      unreadable: why,
    });
    // The header of RFC 8188: salt, record size, length of the key ID.
    if (body.byteLength < 21) return unreadable("The header is cut short");
    const salt = body.slice(0, 16);
    const recordSize = new DataView(body.buffer).getUint32(16);
    const keyIdLength = body[20] ?? 0;
    // RFC 8291 section 4: the key ID is the public key of the sender.
    if (keyIdLength !== 65) {
      return unreadable("The key ID is not a public key of P-256");
    }
    const senderKey = body.slice(21, 21 + keyIdLength);
    const record = body.slice(21 + keyIdLength);
    if (senderKey.byteLength !== 65) {
      return unreadable("The header is cut short");
    }
    // RFC 8291 section 4: one record, which the record size has to hold.
    if (recordSize < 18) return unreadable("The record size is under 18");
    if (record.byteLength > recordSize) {
      return unreadable("The message is more than one record");
    }
    let shared: Bytes;
    try {
      const theirs = await crypto.subtle.importKey(
        "raw",
        senderKey,
        { name: "ECDH", namedCurve: "P-256" },
        false,
        [],
      );
      shared = new Uint8Array(
        await crypto.subtle.deriveBits(
          // Typed by what the runtime at hand takes: the types of the
          // Workers runtime name the other key differently than it does.
          { name: "ECDH", public: theirs } as unknown as Parameters<
            typeof crypto.subtle.deriveBits
          >[0],
          device.privateKey,
          256,
        ),
      );
    } catch {
      return unreadable("The key of the sender is no point of P-256");
    }
    const input = await hkdf(
      device.auth,
      shared,
      concat(bytesOf("WebPush: info\0"), device.publicKey, senderKey),
      32,
    );
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
    let plain: Bytes;
    try {
      const cipher = await crypto.subtle.importKey(
        "raw",
        key,
        "AES-GCM",
        false,
        ["decrypt"],
      );
      plain = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: nonce },
          cipher,
          record,
        ),
      );
    } catch {
      return unreadable("The message does not decrypt with the keys");
    }
    // RFC 8188 section 2: the data, then the byte 2 for the last record,
    // then any number of zeros.
    let end = plain.byteLength;
    while (end > 0 && plain[end - 1] === 0) end -= 1;
    if (end === 0 || plain[end - 1] !== 2) {
      return unreadable("The record does not end as a last record");
    }
    try {
      return {
        payload: decoder.decode(plain.slice(0, end - 1)),
        unreadable: undefined,
      };
    } catch {
      return unreadable("The message is not UTF-8 text");
    }
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // RFC 8030 section 5: a message is a POST to the push resource.
    if (request.method !== "POST") {
      refuse(405, "A message is sent with POST", { Allow: "POST" });
    }
    const device = devices.get(url.origin + url.pathname);
    // An address that no browser was given, and one whose subscription
    // has ended: RFC 8030 section 7.3 has 410 for the second, and the
    // services answer 404 for the first.
    if (!device) refuse(404, "There is no such subscription");
    if (!device.subscribed) refuse(410, "The subscription has ended");

    const from = await sender(
      request.headers.get("Authorization"),
      url.origin,
      device,
    );

    // RFC 8030 section 5.2: a request without TTL is answered with 400.
    const ttl = request.headers.get("TTL");
    if (ttl === null || !/^\d+$/.test(ttl)) {
      refuse(400, "TTL is missing or is not a number of seconds");
    }
    // RFC 8030 section 5.3.
    const urgency = request.headers.get("Urgency") ?? "normal";
    if (!["very-low", "low", "normal", "high"].includes(urgency)) {
      refuse(400, "Urgency is not one of very-low, low, normal and high");
    }
    // RFC 8030 section 5.4: at most 32 characters of base64url.
    const topic = request.headers.get("Topic") ?? undefined;
    if (topic !== undefined && !/^[A-Za-z0-9_-]{1,32}$/.test(topic)) {
      refuse(400, "Topic is not at most 32 characters of base64url");
    }
    const body = new Uint8Array(await request.arrayBuffer());
    // RFC 8030 section 7.2.
    if (body.byteLength > maxBytes) {
      refuse(413, `A message is at most ${maxBytes} bytes`);
    }
    if (body.byteLength === 0) {
      // RFC 8030 lets a message be empty. What a browser makes of one is
      // an event without data, which nothing here has a use for.
      refuse(400, "The message is empty");
    }
    // RFC 8291 section 4: the one encoding of an encrypted message.
    if (request.headers.get("Content-Encoding") !== "aes128gcm") {
      // GUESS: the status.
      refuse(415, "The Content-Encoding is not aes128gcm");
    }

    const fault = faults.shift();
    if (fault === "rate-limit") {
      refuse(429, "Too many requests", { "Retry-After": "60" });
    }
    if (fault === "server-error") refuse(500, "The push service failed");

    // A later message of a topic takes the place of one that waits, RFC
    // 8030 section 5.4. A device of this simulation is always there, so
    // none waits: every message is delivered as it comes.
    device.received.push({
      ...(await decrypted(device, body)),
      ttl: Number(ttl),
      urgency,
      topic,
      sender: from,
      receivedAt: now().getTime(),
    });
    if (fault === "lost-response") {
      throw new TypeError("The answer of the push service was lost");
    }
    return new Response(null, {
      status: 201,
      headers: {
        Location: `${url.origin}/message/${marker}${base64Url(crypto.getRandomValues(new Uint8Array(12)))}`,
        TTL: ttl,
      },
    });
  }

  return {
    owns,

    async fetch(input, init) {
      const request = new Request(input, init);
      const { protocol, host } = new URL(request.url);
      if (protocol !== "https:" || !owns(host)) {
        throw new TypeError(`The simulated push services have no host ${host}`);
      }
      try {
        return await handle(request);
      } catch (error) {
        if (!(error instanceof Refusal)) throw error;
        return Response.json(
          { code: error.status, message: error.reason },
          { status: error.status, headers: error.headers },
        );
      }
    },

    async subscribe({ applicationServerKey, host = pushHosts[0], device }) {
      const key = fromBase64Url(applicationServerKey);
      if (key?.byteLength !== 65 || key[0] !== 4) {
        // What `pushManager.subscribe` fails with for such a key.
        throw new DOMException(
          "The applicationServerKey is not a public key of P-256",
          "InvalidAccessError",
        );
      }
      const algorithm = { name: "ECDH", namedCurve: "P-256" } as const;
      let privateKey: CryptoKey;
      let publicKey: Bytes;
      if (device) {
        const { x = "", y = "" } = device.privateKey;
        privateKey = await crypto.subtle.importKey(
          "jwk",
          device.privateKey,
          algorithm,
          false,
          ["deriveBits"],
        );
        publicKey = concat(
          Uint8Array.of(4),
          fromBase64Url(x) ?? new Uint8Array(),
          fromBase64Url(y) ?? new Uint8Array(),
        );
      } else {
        const pair = await crypto.subtle.generateKey(algorithm, true, [
          "deriveBits",
        ]);
        if (!("privateKey" in pair)) throw new Error("ECDH made no key pair");
        ({ privateKey } = pair);
        publicKey = new Uint8Array(
          (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
        );
      }
      const auth =
        (device && fromBase64Url(device.auth)) ??
        crypto.getRandomValues(new Uint8Array(16));
      const endpoint = `https://${host}/push/${marker}${base64Url(crypto.getRandomValues(new Uint8Array(24)))}`;
      devices.set(endpoint, {
        applicationServerKey,
        privateKey,
        publicKey,
        auth,
        subscribed: true,
        received: [],
      });
      return {
        endpoint,
        keys: { p256dh: base64Url(publicKey), auth: base64Url(auth) },
      };
    },

    unsubscribe(endpoint) {
      const device = devices.get(endpoint);
      if (device) device.subscribed = false;
    },

    received(endpoint) {
      return [...(devices.get(endpoint)?.received ?? [])];
    },

    arm(kind) {
      faults.push(kind);
    },
  };
}
