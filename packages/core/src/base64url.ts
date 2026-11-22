/**
 * Bytes as text in base64url, RFC 4648 section 5, without padding: how
 * keys travel in a push subscription, in a JWK and in a token. With
 * `btoa` and `atob`, which a browser, the Workers runtime and Node have.
 */

/** `bytes` in base64url. */
export function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** The bytes that `text` stands for, or undefined if it is not base64url. */
export function fromBase64Url(
  text: string,
): Uint8Array<ArrayBuffer> | undefined {
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
