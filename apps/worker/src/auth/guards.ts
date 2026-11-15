import { drizzle } from "drizzle-orm/d1";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppDependencies, AppEnv, Auth } from "../env.ts";
import { readAdminEmails } from "./config.ts";
import {
  clearSessionCookie,
  findSession,
  readSessionCookie,
  writeSessionCookie,
} from "./session.ts";

/**
 * Refuses a request that was not made by pigy's own pages. A browser
 * attaches the session cookie to requests that other sites make too, and it
 * tells them apart with the `Origin` header, which a page cannot forge.
 */
export function requireOwnOrigin(c: Context): void {
  if (c.req.header("Origin") !== new URL(c.req.url).origin) {
    throw new HTTPException(403, {
      message: "This request did not come from pigy",
    });
  }
}

/**
 * Refuses a request that changes something and was not made by pigy's own
 * pages. Browsers send `Origin` with every request that is not a GET or a
 * HEAD, so a request without it is refused as well.
 */
export function requireSameOrigin(c: Context): void {
  if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return;
  requireOwnOrigin(c);
}

/**
 * Who the session cookie of the request signs in, and with which session,
 * or null. Other ways to authenticate, such as API keys, belong next to
 * this function: the `Origin` check is only for cookies.
 *
 * Routes use `requireUser`. This is for the one that answers a browser
 * which a network has sent back: it has to send somebody who is not signed
 * in on to a page, where `requireUser` would answer with an error.
 */
export async function authenticateWithCookie(
  c: Context<AppEnv>,
  { now, simulatedGoogle }: AppDependencies,
): Promise<{ auth: Auth; sessionId: string } | null> {
  const token = readSessionCookie(c);
  if (!token) return null;
  requireSameOrigin(c);

  const adminEmails = readAdminEmails(
    c.env,
    simulatedGoogle,
    new URL(c.req.url).origin,
  );
  const time = now();
  const session = await findSession(
    drizzle(c.env.DB),
    token,
    adminEmails,
    time,
  );
  if (!session) {
    clearSessionCookie(c);
    return null;
  }
  // The cookie has to live as long as the session it belongs to.
  if (session.renewed) writeSessionCookie(c, token, session.expiresAt, time);
  return { auth: session.auth, sessionId: session.id };
}

/**
 * Lets only signed-in people through and sets `c.var.auth` and
 * `c.var.sessionId`.
 */
export function requireUser(
  dependencies: AppDependencies,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const session = await authenticateWithCookie(c, dependencies);
    if (!session) {
      throw new HTTPException(401, { message: "Sign in to continue" });
    }
    c.set("auth", session.auth);
    c.set("sessionId", session.sessionId);
    await next();
  };
}

/** Lets only admins through. Goes after `requireUser`. */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.var.auth.role !== "admin") {
    throw new HTTPException(403, { message: "Only admins can do this" });
  }
  await next();
};
