import {
  type AllowedEmail,
  addAllowedEmailRequestSchema,
  allowedEmailListResponseSchema,
  normalizeEmail,
  updateAllowedEmailRequestSchema,
} from "@pigy/core";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { readAdminEmails } from "../auth/config.ts";
import { requireAdmin, requireUser } from "../auth/guards.ts";
import { allowedEmails, sessions, users } from "../db/schema.ts";
import type { AppDependencies, AppEnv } from "../env.ts";
import { parseJsonBody } from "../errors.ts";

/** The allowlist: who may sign in, and as what. Admins only. */
export function adminRoutes(dependencies: AppDependencies): Hono<AppEnv> {
  const { simulatedGoogle, now } = dependencies;
  const app = new Hono<AppEnv>();
  app.use(requireUser(dependencies), requireAdmin);

  const adminEmailsFor = (c: Context<AppEnv>) =>
    readAdminEmails(c.env, simulatedGoogle, new URL(c.req.url).origin);

  /**
   * The address in the path, if the admin making the request may change it.
   * The admins from `ADMIN_EMAILS` are fixed: that variable is how access is
   * regained when the list is wrong. Nobody changes their own entry, so no
   * admin locks themselves out by accident.
   */
  const changeableEmail = (c: Context<AppEnv>): string => {
    const email = normalizeEmail(c.req.param("email") ?? "");
    if (adminEmailsFor(c).has(email)) {
      throw new HTTPException(400, {
        message: `${email} is an admin by configuration and cannot be changed here`,
      });
    }
    if (email === c.var.auth.user.email) {
      throw new HTTPException(400, {
        message: "You cannot change your own access",
      });
    }
    return email;
  };

  app.get("/allowed-emails", async (c) => {
    const db = drizzle(c.env.DB);
    const adminEmails = adminEmailsFor(c);
    const [rows, signedIn] = await db.batch([
      db
        .select({ email: allowedEmails.email, role: allowedEmails.role })
        .from(allowedEmails)
        .orderBy(allowedEmails.email),
      db.selectDistinct({ email: users.email }).from(users),
    ]);
    const signedInEmails = new Set(signedIn.map(({ email }) => email));

    const entries: AllowedEmail[] = [
      ...[...adminEmails].sort().map((email) => ({
        email,
        role: "admin" as const,
        fixed: true,
        signedIn: signedInEmails.has(email),
      })),
      ...rows
        // A row for a fixed admin has no effect while the address is fixed.
        .filter(({ email }) => !adminEmails.has(email))
        .map(({ email, role }) => ({
          email,
          role,
          fixed: false,
          signedIn: signedInEmails.has(email),
        })),
    ];
    return c.json(
      allowedEmailListResponseSchema.parse({ allowedEmails: entries }),
    );
  });

  app.post("/allowed-emails", async (c) => {
    const { email, role } = await parseJsonBody(
      c,
      addAllowedEmailRequestSchema,
    );
    if (adminEmailsFor(c).has(email)) {
      throw new HTTPException(409, {
        message: `${email} is already an admin by configuration`,
      });
    }
    const added = await drizzle(c.env.DB)
      .insert(allowedEmails)
      .values({
        email,
        role,
        invitedBy: c.var.auth.user.id,
        createdAt: now(),
      })
      .onConflictDoNothing()
      .returning({ email: allowedEmails.email });
    if (added.length === 0) {
      throw new HTTPException(409, {
        message: `${email} is already on the list`,
      });
    }
    return c.body(null, 204);
  });

  app.patch("/allowed-emails/:email", async (c) => {
    const email = changeableEmail(c);
    const { role } = await parseJsonBody(c, updateAllowedEmailRequestSchema);
    // Nothing else to do: the role is read from this row on every request.
    const updated = await drizzle(c.env.DB)
      .update(allowedEmails)
      .set({ role })
      .where(eq(allowedEmails.email, email))
      .returning({ email: allowedEmails.email });
    if (updated.length === 0) {
      throw new HTTPException(404, { message: `${email} is not on the list` });
    }
    return c.body(null, 204);
  });

  app.delete("/allowed-emails/:email", async (c) => {
    const email = changeableEmail(c);
    const db = drizzle(c.env.DB);
    // One transaction: the invitation and the sessions go together.
    const [removed] = await db.batch([
      db
        .delete(allowedEmails)
        .where(eq(allowedEmails.email, email))
        .returning({ email: allowedEmails.email }),
      db
        .delete(sessions)
        .where(
          inArray(
            sessions.userId,
            db
              .select({ id: users.id })
              .from(users)
              .where(eq(users.email, email)),
          ),
        ),
    ]);
    if (removed.length === 0) {
      throw new HTTPException(404, { message: `${email} is not on the list` });
    }
    return c.body(null, 204);
  });

  return app;
}
