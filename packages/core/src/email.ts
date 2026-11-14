import { z } from "zod";

/**
 * Brings an email address into the one form pigy stores and compares: no
 * surrounding whitespace, lowercase. Nothing else is touched. In particular
 * the dots and "+tags" that Gmail ignores are kept, because other providers
 * deliver them to different people.
 *
 * It does not check anything. An address that decides who gets in goes
 * through `emailSchema`, which does.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * An email address from outside, normalized: typed by a person, read from the
 * configuration or reported by Google. 254 characters is the longest address
 * that can receive mail.
 *
 * Only ASCII is accepted, and that is checked before anything is changed.
 * Lowercasing turns some other characters into ASCII letters, such as the
 * Kelvin sign U+212A into "k", so checking afterwards would let an address
 * through as somebody else's.
 */
export const emailSchema = z
  .string()
  .regex(/^\p{ASCII}*$/u)
  .transform(normalizeEmail)
  .pipe(z.email().max(254));
