import { z } from "zod";

/**
 * The ID of a synced row or of a sync client: a UUID version 7 (RFC 9562) in
 * lowercase. Whoever creates the thing makes up its ID, so that a client can
 * create rows while it is offline. Only this one spelling is accepted: the
 * same UUID in capitals would be another ID to the database.
 */
export const idSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );

/**
 * A new ID. It begins with the time in milliseconds, so IDs sort roughly in
 * the order they were made. The rest is random.
 */
export function uuidv7(now: Date): string {
  const time = now.getTime().toString(16).padStart(12, "0");
  const random = Array.from(
    crypto.getRandomValues(new Uint8Array(10)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  // The two highest bits of this digit are the variant, "10".
  const variant = (8 + (Number.parseInt(random.charAt(3), 16) & 3)).toString(
    16,
  );
  return [
    time.slice(0, 8),
    time.slice(8),
    // 7 is the version.
    `7${random.slice(0, 3)}`,
    `${variant}${random.slice(4, 7)}`,
    random.slice(8),
  ].join("-");
}
