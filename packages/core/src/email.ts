import { z } from "zod";

/**
 * Brings an email address into the one form pigy stores and compares: no
 * surrounding whitespace, lowercase. Nothing else is touched. In particular
 * the dots and "+tags" that Gmail ignores are kept, because other providers
 * deliver them to different people.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * An email address typed by a person, normalized. 254 characters is the
 * longest address that can receive mail.
 */
export const emailSchema = z
  .string()
  .transform(normalizeEmail)
  .pipe(z.email().max(254));
