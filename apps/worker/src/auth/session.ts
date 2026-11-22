import { and, eq, inArray, isNull, lte, ne, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  allowedEmails,
  apiKeys,
  sessions,
  users,
  workspaces,
} from "../db/schema.ts";
import { randomHex, sha256Hex } from "../digest.ts";
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

/** The workspaces of the accounts that `accounts` selects. */
const workspacesOf = (db: DrizzleD1Database, accounts: SQL | undefined) =>
  db
    .select({ id: workspaces.id })
    .from(workspaces)
    .innerJoin(users, eq(users.id, workspaces.ownerId))
    .where(accounts);

/**
 * Revokes the API keys of the accounts that `accounts` selects. A statement
 * for a batch: a key is revoked with what ends the access of its owner, or
 * a request with the key could find the one without the other.
 */
export const revokeKeysOf = (
  db: DrizzleD1Database,
  accounts: SQL | undefined,
  now: Date,
) =>
  db
    .update(apiKeys)
    .set({ revokedAt: now })
    .where(
      and(
        isNull(apiKeys.revokedAt),
        inArray(apiKeys.workspaceId, workspacesOf(db, accounts)),
      ),
    );

/** Ends the sessions of the accounts that `accounts` selects. */
const endSessionsOf = (db: DrizzleD1Database, accounts: SQL | undefined) =>
  db
    .delete(sessions)
    .where(
      inArray(
        sessions.userId,
        db.select({ id: users.id }).from(users).where(accounts),
      ),
    );

/**
 * The accounts that are stored with `email` and are not the Google account
 * `googleSub`.
 */
const othersWith = (email: string, googleSub: string) =>
  and(eq(users.email, email), ne(users.googleSub, googleSub));

/**
 * What a sign-in that is refused ends, in one batch. Google has just said
 * who the account `googleSub` is today, and that is nobody who may sign in.
 *
 * - Every session of the account, on all devices. Nothing for an account
 *   that has never signed in.
 * - The API keys of the account, unless `verifiedEmail`, the address that
 *   Google has verified for it today, is the address that it is stored
 *   with. Otherwise the account has lost the identity that it was let in
 *   with: its address is no longer verified, or it has another one. A key
 *   is good for as long as the stored address of its owner is invited, and
 *   that address stays stored, so the keys would go on working for
 *   somebody of whom nothing says any more that the address is theirs.
 * - The sessions and the API keys of every other account that is stored
 *   with `verifiedEmail`, as `revokeAccessOfOtherAccountsWith` ends them
 *   at a sign-in that succeeds. Google says today that the address is this
 *   account's, so an account that was let in with it earlier has lost it,
 *   whether or not the address is invited now. Left alone, its keys would
 *   work again the day the address is invited for the person who has it
 *   now, until that person first signs in.
 *
 * Keys that are revoked do not come back: the person makes new ones once
 * they have signed in again.
 */
export async function revokeAccessAtRefusedSignIn(
  db: DrizzleD1Database,
  googleSub: string,
  verifiedEmail: string | undefined,
  now: Date,
): Promise<void> {
  const account = eq(users.googleSub, googleSub);
  if (verifiedEmail === undefined) {
    await db.batch([
      endSessionsOf(db, account),
      revokeKeysOf(db, account, now),
    ]);
    return;
  }
  const others = othersWith(verifiedEmail, googleSub);
  await db.batch([
    endSessionsOf(db, account),
    revokeKeysOf(db, and(account, ne(users.email, verifiedEmail)), now),
    endSessionsOf(db, others),
    revokeKeysOf(db, others, now),
  ]);
}

/**
 * Ends every session of the accounts that are stored with `email` and are
 * not the Google account `googleSub`, and revokes their API keys, in one
 * batch. Google has just said that the address belongs to `googleSub`
 * today, so an account that was let in with it earlier has lost it since:
 * its sessions and its keys are matched against that address, and would
 * go on working with the role of the address.
 */
export async function revokeAccessOfOtherAccountsWith(
  db: DrizzleD1Database,
  email: string,
  googleSub: string,
  now: Date,
): Promise<void> {
  const others = othersWith(email, googleSub);
  await db.batch([endSessionsOf(db, others), revokeKeysOf(db, others, now)]);
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
): Promise<{
  id: string;
  auth: Auth;
  expiresAt: Date;
  renewed: boolean;
} | null> {
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
    return {
      id: session.id,
      auth,
      expiresAt: session.expiresAt,
      renewed: false,
    };
  }
  await db
    .update(sessions)
    .set({ expiresAt })
    .where(eq(sessions.id, session.id));
  return { id: session.id, auth, expiresAt, renewed: true };
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
