import { SignJWT } from "jose";

/**
 * A sender of Web Push for the tests of the simulated push service,
 * written from RFC 8291 and RFC 8292 with nothing of pigy's: the token is
 * made with `jose`, and every part of a request can be bent, which is how
 * the tests show what the service refuses.
 */

export const b64 = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

export const unb64 = (text: string) =>
  Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
    c.charCodeAt(0),
  );

const encoder = new TextEncoder();

const join = (...parts: Uint8Array[]) => {
  const all = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  return all;
};

/** A sender: its key pair, and the public key as a page subscribes with it. */
export async function newSender() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  return {
    privateKey: pair.privateKey,
    publicKey: b64(await crypto.subtle.exportKey("raw", pair.publicKey)),
  };
}

export type Sender = Awaited<ReturnType<typeof newSender>>;

/** The value of `Authorization` for a request of `sender` to `endpoint`. */
export async function authorization(
  sender: Sender,
  endpoint: string,
  at: Date,
  claims: Record<string, unknown> = {},
): Promise<string> {
  const token = await new SignJWT({
    aud: new URL(endpoint).origin,
    exp: Math.floor(at.getTime() / 1000) + 60 * 60,
    sub: "mailto:tests@pigy.example",
    ...claims,
  })
    .setProtectedHeader({ typ: "JWT", alg: "ES256" })
    .sign(sender.privateKey);
  return `vapid t=${token}, k=${sender.publicKey}`;
}

const hkdf = async (
  salt: Uint8Array<ArrayBuffer>,
  secret: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  length: number,
) =>
  new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info },
      await crypto.subtle.importKey("raw", secret, "HKDF", false, [
        "deriveBits",
      ]),
      length * 8,
    ),
  );

/**
 * `text` encrypted for the device with `keys`, RFC 8291. `bend` changes
 * what goes into the message: the padding after the text, and the record
 * size in the header.
 */
export async function encrypted(
  keys: { p256dh: string; auth: string },
  text: string,
  bend: { padding?: Uint8Array; recordSize?: number } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const mine = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  const theirs = unb64(keys.p256dh);
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "ECDH",
        public: await crypto.subtle.importKey(
          "raw",
          theirs,
          { name: "ECDH", namedCurve: "P-256" },
          false,
          [],
        ),
      },
      pair.privateKey,
      256,
    ),
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const input = await hkdf(
    unb64(keys.auth),
    shared,
    join(encoder.encode("WebPush: info\0"), theirs, mine),
    32,
  );
  const key = await hkdf(
    salt,
    input,
    encoder.encode("Content-Encoding: aes128gcm\0"),
    16,
  );
  const nonce = await hkdf(
    salt,
    input,
    encoder.encode("Content-Encoding: nonce\0"),
    12,
  );
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]),
    join(encoder.encode(text), bend.padding ?? Uint8Array.of(2)),
  );
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, bend.recordSize ?? 4096);
  return join(salt, size, Uint8Array.of(65), mine, new Uint8Array(sealed));
}
