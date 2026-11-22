import {
  emailSchema,
  meResponseSchema,
  type SignInError,
  safeReturnTo,
} from "@pigy/core";
import { drizzle } from "drizzle-orm/d1";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { users } from "../db/schema.ts";
import type { AppDependencies, AppEnv } from "../env.ts";
import { log } from "../log.ts";
import { reviewFreezeOf } from "../workspace/workspaces.ts";
import { roleOf } from "./access.ts";
import { accessConfig } from "./config.ts";
import {
  beginSignIn,
  completeSignIn,
  signInFailure,
  signInFlowSchema,
} from "./google.ts";
import { requireSameOrigin, requireUser } from "./guards.ts";
import {
  clearSessionCookie,
  cookieName,
  createSession,
  deleteExpiredSessions,
  isSecure,
  readSessionCookie,
  revokeAccessAtRefusedSignIn,
  revokeAccessOfOtherAccountsWith,
  revokeSession,
  thawWorkspacesOf,
  writeSessionCookie,
} from "./session.ts";

// How long somebody may take at Google before the sign-in has to be started
// again.
const signInMinutes = 10;

// A cookie holds about 4000 characters. An address longer than this is not
// one of pigy's, and would leave no room for the other values.
const maxReturnToLength = 1000;

const signInCookieSchema = signInFlowSchema.extend({
  returnTo: z.string(),
});

type SignInCookie = z.infer<typeof signInCookieSchema>;

/**
 * The state, nonce and PKCE verifier of a sign-in live in a cookie, so that
 * the callback is only accepted in the browser that started the sign-in.
 */
function writeSignInCookie(c: Context<AppEnv>, value: SignInCookie): void {
  setCookie(c, cookieName(c, "pigy_sign_in"), JSON.stringify(value), {
    httpOnly: true,
    // Google sends the browser back with a navigation from another site,
    // which "Strict" would strip of this cookie.
    sameSite: "Lax",
    secure: isSecure(c),
    path: "/",
    maxAge: signInMinutes * 60,
  });
}

/** Reads the cookie and removes it: a sign-in can be finished only once. */
function takeSignInCookie(c: Context<AppEnv>): SignInCookie | undefined {
  const name = cookieName(c, "pigy_sign_in");
  const value = getCookie(c, name);
  deleteCookie(c, name, { secure: isSecure(c), path: "/" });
  if (!value) return undefined;
  try {
    return signInCookieSchema.parse(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function signInFailed(c: Context<AppEnv>, error: SignInError): Response {
  return c.redirect(`/sign-in?error=${error}`);
}

export function authRoutes(dependencies: AppDependencies): Hono<AppEnv> {
  const { fetch, now, simulatedGoogle } = dependencies;
  const app = new Hono<AppEnv>();

  const configFor = (c: Context<AppEnv>) => {
    const { origin } = new URL(c.req.url);
    return {
      ...accessConfig(c.env, fetch, simulatedGoogle, origin),
      // Has to be registered with the Google client, character by character.
      redirectUri: `${origin}/api/auth/google/callback`,
    };
  };

  app.get("/auth/google/start", async (c) => {
    const { google, redirectUri } = configFor(c);
    if (!google) {
      log.error(
        "configuration",
        "Sign-in is refused: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set.",
      );
      return signInFailed(c, "not_configured");
    }
    const returnTo = c.req.query("returnTo") ?? "/";

    const begun = await beginSignIn(google, redirectUri).catch(
      (error: unknown) => {
        // Google could not be reached, or did not answer as expected.
        log.error(
          "sign-in",
          "Sign-in could not start",
          {},
          signInFailure(error),
        );
      },
    );
    if (!begun) return signInFailed(c, "failed");
    writeSignInCookie(c, {
      ...begun.flow,
      returnTo: returnTo.length > maxReturnToLength ? "/" : returnTo,
    });
    return c.redirect(google.browserUrl(begun.url).href);
  });

  app.get("/auth/google/callback", async (c) => {
    const { google, adminEmails, redirectUri } = configFor(c);
    const flow = takeSignInCookie(c);
    if (!google || !flow) return signInFailed(c, "failed");

    const identity = await completeSignIn(
      google,
      redirectUri,
      new URL(c.req.url),
      flow,
      now,
    ).catch((error: unknown) => {
      // Somebody cancelled at Google, took too long, or sent a callback that
      // does not belong to their sign-in. The reason goes to the logs only,
      // and only the reason: `signInFailure`.
      log.warn("sign-in", "Sign-in did not complete", {}, signInFailure(error));
    });
    if (!identity) return signInFailed(c, "failed");

    const db = drizzle(c.env.DB);
    // The address to look for among the invitations, if this identity has
    // one that counts. An address that Google has not verified proves
    // nothing about who is signing in. One that the schema refuses cannot
    // have been invited, and normalizing it regardless could turn it into
    // one that was.
    const email = identity.emailVerified
      ? emailSchema.safeParse(identity.email).data
      : undefined;
    // Checked on every sign-in, not only the first: an invitation can end.
    const role = email ? await roleOf(db, adminEmails, email) : null;
    if (!email || !role) {
      // Google has just said who this account is today, and that is nobody
      // who may sign in. If the account was let in before, with an address
      // that it has lost since or that is no longer verified, its sessions
      // end here, on every device. They are matched against the address of
      // that earlier sign-in, and would go on working with the role that
      // address has.
      //
      // The stored address stays as it is. Nothing is stored about somebody
      // who is not invited, which is what the address Google reports now
      // would be, and an unverified one proves nothing. The old address
      // gives no access any more either. With the sessions gone, only a
      // sign-in that succeeds starts one, and it stores the address of that
      // day first. And the API keys of the account, which are good for as
      // long as its stored address is invited, are revoked here unless
      // Google has verified that very address for the account today.
      //
      // An address that Google has verified for this account is no longer
      // that of any other account, invited or not. So the access of the
      // accounts that are stored with it ends here too, as at a sign-in
      // that succeeds: their keys would otherwise work again the day the
      // address is invited for the person who has it now.
      //
      // The workspaces of the accounts whose keys are revoked are frozen
      // with them, and their objects are told, through `waitUntil`: the
      // browser is sent on without waiting for that.
      const frozen = await revokeAccessAtRefusedSignIn(
        db,
        identity.sub,
        email,
        now(),
      );
      c.executionCtx.waitUntil(reviewFreezeOf(c.env.WORKSPACE, frozen));
      return identity.emailVerified
        ? c.redirect("/invite-only")
        : signInFailed(c, "email_not_verified");
    }

    const time = now();
    const name = identity.name?.trim() || email;
    const [user] = await db
      .insert(users)
      .values({
        id: crypto.randomUUID(),
        googleSub: identity.sub,
        email,
        name,
        createdAt: time,
      })
      // The account is known by its Google ID. Its email address and name
      // are whatever Google says today.
      .onConflictDoUpdate({ target: users.googleSub, set: { email, name } })
      .returning({ id: users.id });
    if (!user) throw new Error("The user was not stored");

    // An address can move from one Google account to another, for example
    // when an organization gives it to somebody new. The account that had
    // it before is still stored with it, and its sessions are matched
    // against that address, so they would go on working with the role of
    // the address without that account ever signing in again.
    // Its API keys are matched against it too, and are revoked, and its
    // workspaces are frozen.
    const frozen = await revokeAccessOfOtherAccountsWith(
      db,
      email,
      identity.sub,
      time,
    );
    // The account that signs in has its access, so its workspaces thaw,
    // if they were frozen, before it has a session: the first thing that
    // the app does with one is to open a workspace. Only if it still has
    // the access, which the statement asks again: `thawWorkspacesOf`.
    const thawed = await thawWorkspacesOf(db, user.id, email, adminEmails);
    c.executionCtx.waitUntil(
      reviewFreezeOf(c.env.WORKSPACE, [...frozen, ...thawed]),
    );

    // The session a browser had before this sign-in ends here. The new one
    // gets a token that never left the server before, so nobody can have
    // planted it in this browser in advance.
    const previous = readSessionCookie(c);
    if (previous) await revokeSession(db, previous);
    await deleteExpiredSessions(db, user.id, time);
    const session = await createSession(db, user.id, time);
    writeSessionCookie(c, session.token, session.expiresAt, time);
    // Checked here, where it is used, and not before it went into the
    // cookie: what comes back in a cookie is the browser's word.
    return c.redirect(safeReturnTo(flow.returnTo));
  });

  app.post("/auth/sign-out", async (c) => {
    requireSameOrigin(c);
    const token = readSessionCookie(c);
    if (token) await revokeSession(drizzle(c.env.DB), token);
    clearSessionCookie(c);
    return c.body(null, 204);
  });

  app.get("/me", requireUser(dependencies), (c) =>
    c.json(meResponseSchema.parse(c.var.auth)),
  );

  return app;
}
