import { and, eq, inArray, lte } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { allowedEmails, sessions, users } from "../db/schema.ts";
import type { AppEnv, Auth } from "../env.ts";

/**
 * Sessions, built the way https://auth.pilcrowonpaper.com/sessions and the
 * reference code at https://lucia-auth.com describe. The cookie holds a
 * token, "<id>.<secret>". The database holds the ID and a SHA-256 of the
 * secret, and a session is revoked by deleting its row.
 */

const dayMs = 24 * 60 * 60 * 1000;
const lifetimeMs = 30 * dayMs;
// A session that is in use always has its 30 days ahead of it, give or take
// this much. Moving the expiry on every request would cost a write each time.
const renewAfterMs = dayMs;

const encoder = new TextEncoder();

function randomHex(bytes: number): string {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

/** Starts a session and returns the token for the cookie. */
export async function createSession(
  db: DrizzleD1Database,
  userId: string,
  now: Date,
): Promise<{ token: string; expiresAt: Date }> {
  const id = randomHex(16);
  // 256 bits from the system's random source: not guessable. That also makes
  // a fast hash enough, unlike for a password.
  const secret = randomHex(32);
  const expiresAt = new Date(now.getTime() + lifetimeMs);
  await db.insert(sessions).values({
    id,
    secretHash: await sha256Hex(secret),
    userId,
    createdAt: now,
    expiresAt,
  });
  return { token: `${id}.${secret}`, expiresAt };
}

/**
 * The row of the session that `token` belongs to, if the secret in the token
 * is the right one.
 */
async function verifiedSession(db: DrizzleD1Database, token: string) {
  const [id, secret, ...rest] = token.split(".");
  if (!id || !secret || rest.length > 0) return null;
  const [row] = await db
    .select({
      id: sessions.id,
      secretHash: sessions.secretHash,
      expiresAt: sessions.expiresAt,
      userId: users.id,
      email: users.email,
      name: users.name,
      role: allowedEmails.role,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .leftJoin(allowedEmails, eq(allowedEmails.email, users.email))
    .where(eq(sessions.id, id));
  if (!row) return null;

  const expected = encoder.encode(row.secretHash);
  const actual = encoder.encode(await sha256Hex(secret));
  // Compared in constant time, so that the time a wrong secret takes says
  // nothing about how much of it was right. `timingSafeEqual` is the Workers
  // runtime's own, and wants both sides to have the same length.
  if (
    expected.byteLength !== actual.byteLength ||
    !crypto.subtle.timingSafeEqual(expected, actual)
  ) {
    return null;
  }
  return row;
}

async function deleteSession(db: DrizzleD1Database, id: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, id));
}

/** Ends the session that `token` belongs to. */
export async function revokeSession(
  db: DrizzleD1Database,
  token: string,
): Promise<void> {
  const session = await verifiedSession(db, token);
  if (session) await deleteSession(db, session.id);
}

/**
 * Ends every session of the Google account `googleSub`, on all devices. Does
 * nothing for an account that has never signed in.
 */
export async function revokeSessionsOfAccount(
  db: DrizzleD1Database,
  googleSub: string,
): Promise<void> {
  await db
    .delete(sessions)
    .where(
      inArray(
        sessions.userId,
        db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.googleSub, googleSub)),
      ),
    );
}

/**
 * Who `token` signs in, or null. The role is read on every call, so a change
 * of role, or the end of an invitation, applies to the very next request.
 */
export async function findSession(
  db: DrizzleD1Database,
  token: string,
  adminEmails: ReadonlySet<string>,
  now: Date,
): Promise<{ auth: Auth; expiresAt: Date; renewed: boolean } | null> {
  const session = await verifiedSession(db, token);
  if (!session) return null;

  const role = adminEmails.has(session.email) ? "admin" : session.role;
  if (now >= session.expiresAt || !role) {
    await deleteSession(db, session.id);
    return null;
  }

  const auth = {
    user: { id: session.userId, email: session.email, name: session.name },
    role,
  };
  const expiresAt = new Date(now.getTime() + lifetimeMs);
  if (expiresAt.getTime() - session.expiresAt.getTime() < renewAfterMs) {
    return { auth, expiresAt: session.expiresAt, renewed: false };
  }
  await db
    .update(sessions)
    .set({ expiresAt })
    .where(eq(sessions.id, session.id));
  return { auth, expiresAt, renewed: true };
}

/** Removes the sessions of `userId` that have run out. */
export async function deleteExpiredSessions(
  db: DrizzleD1Database,
  userId: string,
  now: Date,
): Promise<void> {
  await db
    .delete(sessions)
    .where(and(eq(sessions.userId, userId), lte(sessions.expiresAt, now)));
}

/** Whether cookies set on this request can be limited to HTTPS. */
export function isSecure(c: Context): boolean {
  return new URL(c.req.url).protocol === "https:";
}

/**
 * The name of a cookie of this app. Over HTTPS it carries the "__Host-"
 * prefix, which makes browsers refuse the cookie unless this very host set
 * it, over HTTPS, for all its paths. Another site under the same parent
 * domain can then not plant one. Local development is plain HTTP, where the
 * prefix cannot be used.
 */
export function cookieName(c: Context, name: string): string {
  return isSecure(c) ? `__Host-${name}` : name;
}

export function readSessionCookie(c: Context<AppEnv>): string | undefined {
  return getCookie(c, cookieName(c, "pigy_session"));
}

export function writeSessionCookie(
  c: Context<AppEnv>,
  token: string,
  expiresAt: Date,
  now: Date,
): void {
  setCookie(c, cookieName(c, "pigy_session"), token, {
    // Not readable by scripts, so a script injected into a page cannot take
    // the session elsewhere.
    httpOnly: true,
    // Sent when a link from elsewhere is followed, so that it opens pigy
    // signed in, but not with requests that other sites make.
    sameSite: "Lax",
    secure: isSecure(c),
    path: "/",
    maxAge: Math.floor((expiresAt.getTime() - now.getTime()) / 1000),
  });
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  deleteCookie(c, cookieName(c, "pigy_session"), {
    secure: isSecure(c),
    path: "/",
  });
}
