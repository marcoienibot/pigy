/**
 * What the Worker makes its own secrets and names with: random values and
 * SHA-256 digests, both written as hex.
 */

const encoder = new TextEncoder();

export function hex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** `bytes` bytes from the system's random source, as hex. */
export function randomHex(bytes: number): string {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** A SHA-256 of `text`, as hex. */
export async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}
