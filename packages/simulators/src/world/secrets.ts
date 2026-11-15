// What every secret of a simulated network begins with.
const prefix = "pigy-sim-";

/**
 * A new secret of a simulated network: a client secret, an authorization
 * code, an access token. It is as hard to guess as a real one, and it says
 * what it is. Nobody can take it for a secret of a real service, and no
 * real service accepts it.
 */
export function simulatedSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return (
    prefix +
    btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "")
  );
}

/**
 * Whether `value` is a secret that a simulator made. A simulator looks no
 * further at anything else: a real credential that reaches it by mistake is
 * refused before it is compared with anything or kept anywhere.
 */
export function isSimulatedSecret(value: string): boolean {
  return value.startsWith(prefix);
}
