import type { Role } from "@pigy/core";
import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { allowedEmails } from "../db/schema.ts";

/**
 * What `email` may do, or null if it may not sign in at all. `email` must be
 * normalized.
 */
export async function roleOf(
  db: DrizzleD1Database,
  adminEmails: ReadonlySet<string>,
  email: string,
): Promise<Role | null> {
  if (adminEmails.has(email)) return "admin";
  const [allowed] = await db
    .select({ role: allowedEmails.role })
    .from(allowedEmails)
    .where(eq(allowedEmails.email, email));
  return allowed?.role ?? null;
}
