/** `bytes` in base64url without padding, as OAuth writes its values. */
export function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
