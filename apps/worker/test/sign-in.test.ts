import { resignIdToken } from "@pigy/simulators/google";
import * as oauth from "oauth4webapi";
import { expect, it } from "vitest";
import { sessions, users } from "../src/db/schema.ts";
import {
  adminEmail,
  consent,
  expectWarnings,
  invite,
  locationOf,
  me,
  setup,
  signedIn,
  signIn,
} from "./helpers.ts";

it("signs in somebody who is invited", async () => {
  const test = setup();
  await invite(test, "ada@example.com");
  const browser = test.browser();

  const response = await signIn(test, browser, {
    email: "ada@example.com",
    name: "Ada Lovelace",
  });

  expect(locationOf(response)).toBe("/");
  expect(await me(browser)).toMatchObject({
    user: { email: "ada@example.com", name: "Ada Lovelace" },
    role: "member",
  });
});

it("sets a session cookie that scripts and other sites cannot use", async () => {
  const test = setup();
  const browser = test.browser();

  await signIn(test, browser, { email: adminEmail });

  const cookie = browser.lastSetCookies.find((value) =>
    value.includes("pigy_session="),
  );
  // The prefix makes browsers insist on Secure, Path=/ and no Domain.
  expect(cookie).toMatch(/^__Host-pigy_session=[0-9a-f]+\.[0-9a-f]+; /);
  const attributes = cookie?.split("; ").slice(1);
  expect(attributes).toEqual(
    expect.arrayContaining(["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]),
  );
  // 30 days, like the session.
  expect(attributes).toContain(`Max-Age=${30 * 24 * 60 * 60}`);
  expect(attributes?.some((value) => value.startsWith("Domain"))).toBe(false);
});

it("leaves out Secure and the prefix over plain HTTP", async () => {
  // Local development is plain HTTP, where a browser other than Chrome would
  // drop a Secure cookie and nobody could sign in.
  const local = "http://localhost:5173";
  const test = setup();
  const browser = test.browser(local);

  // The simulated Google of the helpers has only the HTTPS address
  // registered, so this sign-in cannot go further than the first step.
  const start = await browser.fetch("/api/auth/google/start");

  expect(new URL(locationOf(start)).searchParams.get("redirect_uri")).toBe(
    `${local}/api/auth/google/callback`,
  );
  const [cookie] = browser.lastSetCookies;
  expect(cookie).toMatch(/^pigy_sign_in=/);
  expect(cookie).toContain("HttpOnly");
  expect(cookie).not.toContain("Secure");
});

it("keeps the state, nonce and PKCE verifier in a short-lived cookie", async () => {
  const test = setup();
  const browser = test.browser();

  const start = await browser.fetch("/api/auth/google/start");

  const [cookie] = browser.lastSetCookies;
  expect(cookie).toMatch(/^__Host-pigy_sign_in=/);
  expect(cookie?.split("; ")).toEqual(
    expect.arrayContaining([
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
      "Path=/",
      "Max-Age=600",
    ]),
  );
  const google = new URL(locationOf(start));
  expect(google.origin + google.pathname).toBe(
    "https://accounts.google.com/o/oauth2/v2/auth",
  );
  const stored = JSON.parse(
    decodeURIComponent(browser.cookies.get("__Host-pigy_sign_in") ?? ""),
  );
  expect(google.searchParams.get("state")).toBe(stored.state);
  expect(google.searchParams.get("nonce")).toBe(stored.nonce);
  expect(google.searchParams.get("code_challenge_method")).toBe("S256");
  // The verifier stays in the cookie. Google only gets its hash.
  expect(start.headers.get("Location")).not.toContain(stored.codeVerifier);
  // Nothing about a sign-in is stored before it has succeeded.
  expect(await test.db.select().from(sessions)).toEqual([]);
});

it("refuses somebody who is not invited and stores nothing about them", async () => {
  const test = setup();
  const browser = test.browser();

  const response = await signIn(test, browser, { email: "eve@example.com" });

  expect(locationOf(response)).toBe("/invite-only");
  expect(await me(browser)).toBeNull();
  expect(browser.cookies.size).toBe(0);
  expect(await test.db.select().from(users)).toEqual([]);
  expect(await test.db.select().from(sessions)).toEqual([]);
});

it("refuses an email address that Google has not verified", async () => {
  const test = setup();
  const browser = test.browser();

  // The address of the admin: anybody can create a Google account that
  // claims an address, only a verified one proves that they own it.
  const response = await signIn(test, browser, {
    email: adminEmail,
    verified: false,
  });

  expect(locationOf(response)).toBe("/sign-in?error=email_not_verified");
  expect(await me(browser)).toBeNull();
  expect(await test.db.select().from(users)).toEqual([]);
});

it("matches invitations without regard to case", async () => {
  const test = setup();
  await invite(test, "ada@example.com");
  const browser = test.browser();

  await signIn(test, browser, { email: "Ada@Example.COM" });

  expect(await me(browser)).toMatchObject({
    user: { email: "ada@example.com" },
  });
});

it("refuses an address that only lowercasing turns into an invited one", async () => {
  const test = setup();
  await invite(test, "kate@example.com");
  const browser = test.browser();

  // U+212A, the Kelvin sign, lowercases to "k". An address with it is
  // another address than Kate's, whoever it belongs to, and must not be
  // matched with her invitation.
  const response = await signIn(test, browser, {
    email: "\u212aate@example.com",
  });

  expect(locationOf(response)).toBe("/invite-only");
  expect(await me(browser)).toBeNull();
  expect(await test.db.select().from(users)).toEqual([]);
  // Kate herself gets in, so the refusal above was not for a missing
  // invitation.
  expect(
    locationOf(await signIn(test, browser, { email: "Kate@example.com" })),
  ).toBe("/");
});

it("knows an account by its Google ID, not by its email address", async () => {
  const test = setup();
  await invite(test, "old@example.com");
  await invite(test, "new@example.com");

  const before = await me(
    await signedIn(test, { email: "old@example.com", sub: "1001" }),
  );
  // The same Google account after its address was changed.
  const after = await me(
    await signedIn(test, { email: "new@example.com", sub: "1001" }),
  );

  expect(after?.user.email).toBe("new@example.com");
  expect(after?.user.id).toBe(before?.user.id);
  expect(await test.db.select().from(users)).toHaveLength(1);
});

it.each([
  [
    "its address is now one that is not invited",
    { email: "moved@example.com" },
    "/invite-only",
  ],
  [
    "Google no longer vouches for its address",
    { email: adminEmail, verified: false },
    "/sign-in?error=email_not_verified",
  ],
])(
  "signs a known account out everywhere when %s",
  async (_name, today, refusal) => {
    const test = setup();
    await invite(test, "ada@example.com");
    const phone = await signedIn(test, { email: adminEmail, sub: "1001" });
    const laptop = await signedIn(test, { email: adminEmail, sub: "1001" });
    const ada = await signedIn(test, { email: "ada@example.com" });

    // The same Google account signs in again, as what Google says it is
    // today. In a third browser, so that the two above are not signed out
    // through anything this one sends.
    const response = await signIn(test, test.browser(), {
      ...today,
      sub: "1001",
    });

    expect(locationOf(response)).toBe(refusal);
    // Looked up in the database before the app is asked: the sessions are
    // gone at once, not when they are next used. Ada's is the one left.
    expect(await test.db.select().from(sessions)).toHaveLength(1);
    // Left alone, both would still be signed in as the admin: a session goes
    // by the address its account was let in with.
    expect(await me(phone)).toBeNull();
    expect(await me(laptop)).toBeNull();
    // Nobody else is affected.
    expect(await me(ada)).not.toBeNull();
    // The refused address is not stored, like that of anybody who is not
    // invited. The account keeps the one it was last let in with.
    const stored = await test.db.select({ email: users.email }).from(users);
    expect(stored.map(({ email }) => email).sort()).toEqual([
      "ada@example.com",
      adminEmail,
    ]);
  },
);

it("signs an account out everywhere when its address moves to another Google account", async () => {
  const test = setup();
  await invite(test, "ada@example.com");
  await invite(test, "bob@example.com");
  const phone = await signedIn(test, { email: "ada@example.com", sub: "1001" });
  const laptop = await signedIn(test, {
    email: "ada@example.com",
    sub: "1001",
  });
  const bob = await signedIn(test, { email: "bob@example.com", sub: "3003" });

  // Another Google account now has the address, as when an organization
  // gives the address of somebody who left to somebody new. The account
  // that had it never signs in again, so nothing is refused.
  const successor = await signedIn(test, {
    email: "ada@example.com",
    sub: "2002",
  });

  // The successor is in, as a user of their own.
  expect((await me(successor))?.user.email).toBe("ada@example.com");
  expect(await test.db.select().from(users)).toHaveLength(3);
  // Left alone, both would still be signed in as ada@example.com: a session
  // goes by the address its account was last let in with.
  expect(await me(phone)).toBeNull();
  expect(await me(laptop)).toBeNull();
  // Only accounts stored with that address are affected.
  expect(await me(bob)).not.toBeNull();
});

it("returns to the page the sign-in was started for", async () => {
  const test = setup();
  const browser = test.browser();

  const response = await signIn(
    test,
    browser,
    { email: adminEmail },
    "/settings/access?tab=1",
  );

  expect(locationOf(response)).toBe("/settings/access?tab=1");
});

it.each([
  "https://evil.example/",
  "//evil.example",
  "/\\evil.example",
  "/.//evil.example",
])("does not return to another site: %s", async (returnTo) => {
  const test = setup();
  const browser = test.browser();

  const response = await signIn(test, browser, { email: adminEmail }, returnTo);

  expect(locationOf(response)).toBe("/");
});

it("drops a return address that is too long for the cookie", async () => {
  const test = setup();
  const browser = test.browser();

  // Browsers drop a cookie that is too large, and without the cookie the
  // sign-in could not be finished at all.
  const response = await signIn(
    test,
    browser,
    { email: adminEmail },
    `/${"a".repeat(5000)}`,
  );

  expect(locationOf(response)).toBe("/");
});

it("refuses a callback whose state was changed", async () => {
  expectWarnings();
  const test = setup();
  const browser = test.browser();
  const start = await browser.fetch("/api/auth/google/start");
  const callback = new URL(
    await consent(test, locationOf(start), { email: adminEmail }),
  );

  // Everything else about this callback is right: the code, and with the
  // cookie the nonce and the PKCE verifier. Only the state check can refuse.
  callback.searchParams.set("state", "another-state");
  const response = await browser.fetch(callback.pathname + callback.search);

  expect(locationOf(response)).toBe("/sign-in?error=failed");
  expect(await me(browser)).toBeNull();
});

it("refuses a callback that belongs to somebody else's sign-in", async () => {
  expectWarnings();
  const test = setup();
  const victim = test.browser();
  const attacker = test.browser();

  // The attacker completes a sign-in at Google with their own account and
  // gets the victim's browser to open the callback, to sign the victim in
  // as the attacker. The victim's browser has started a sign-in of its own.
  await victim.fetch("/api/auth/google/start");
  const start = await attacker.fetch("/api/auth/google/start");
  const callback = await consent(test, locationOf(start), {
    email: adminEmail,
  });
  const response = await victim.fetch(callback);

  expect(locationOf(response)).toBe("/sign-in?error=failed");
  expect(await me(victim)).toBeNull();
  // The callback is still good in the browser it belongs to, so the refusal
  // above was for the browser and nothing else.
  expect(locationOf(await attacker.fetch(callback))).toBe("/");
});

it("refuses a callback in a browser that did not start a sign-in", async () => {
  const test = setup();
  const start = await test.browser().fetch("/api/auth/google/start");
  const callback = await consent(test, locationOf(start), {
    email: adminEmail,
  });

  const other = test.browser();
  const response = await other.fetch(callback);

  expect(locationOf(response)).toBe("/sign-in?error=failed");
  expect(await me(other)).toBeNull();
});

it("refuses an ID token that was issued for another nonce", async () => {
  const warn = expectWarnings();
  const test = setup();
  const browser = test.browser();
  const start = await browser.fetch("/api/auth/google/start");

  // Google is asked for a token with a nonce that is not the one in the
  // cookie, as if a token from another sign-in were injected.
  const tampered = new URL(locationOf(start));
  tampered.searchParams.set("nonce", "another-nonce");
  const callback = await consent(test, tampered.href, { email: adminEmail });
  const response = await browser.fetch(callback);

  expect(locationOf(response)).toBe("/sign-in?error=failed");
  expect(await me(browser)).toBeNull();
  // The state was right and Google issued the token, so it was the nonce
  // check that refused it.
  expect(String(warn.mock.calls[0]?.[1])).toContain("nonce");
});

it("fails when the PKCE verifier does not fit the challenge", async () => {
  const warn = expectWarnings();
  const test = setup();
  const browser = test.browser();
  const start = await browser.fetch("/api/auth/google/start");

  // The code is issued for another challenge than the one the verifier in
  // the cookie belongs to, as if the code came from somebody else's sign-in.
  const tampered = new URL(locationOf(start));
  tampered.searchParams.set("code_challenge", "x".repeat(43));
  const callback = await consent(test, tampered.href, { email: adminEmail });
  const response = await browser.fetch(callback);

  expect(locationOf(response)).toBe("/sign-in?error=failed");
  expect(await me(browser)).toBeNull();
  // Google refused the code, which is what PKCE is for.
  expect(JSON.stringify(warn.mock.calls[0]?.[1])).toContain("invalid_grant");
});

it("accepts a callback only once", async () => {
  expectWarnings();
  const test = setup();
  const browser = test.browser();
  const start = await browser.fetch("/api/auth/google/start");
  const signInCookie = browser.cookies.get("__Host-pigy_sign_in");
  const callback = await consent(test, locationOf(start), {
    email: adminEmail,
  });
  expect(locationOf(await browser.fetch(callback))).toBe("/");

  // Replayed as it is: the first use has removed the sign-in cookie.
  expect(browser.cookies.has("__Host-pigy_sign_in")).toBe(false);
  const replayed = test.browser();
  expect(locationOf(await replayed.fetch(callback))).toBe(
    "/sign-in?error=failed",
  );

  // Replayed together with the cookie, by somebody who got hold of both:
  // Google redeems a code only once.
  const thief = test.browser();
  thief.cookies.set("__Host-pigy_sign_in", signInCookie ?? "");
  expect(locationOf(await thief.fetch(callback))).toBe("/sign-in?error=failed");
  expect(await me(thief)).toBeNull();
});

it("goes back to the sign-in page when somebody cancels at Google", async () => {
  expectWarnings();
  const test = setup();
  const browser = test.browser();
  const start = await browser.fetch("/api/auth/google/start");

  const cancelled = await test.google.fetch(locationOf(start), {
    method: "POST",
    body: new URLSearchParams({ action: "cancel" }),
  });
  const response = await browser.fetch(locationOf(cancelled));

  expect(locationOf(response)).toBe("/sign-in?error=failed");
  expect(await me(browser)).toBeNull();
});

it("refuses an ID token that has expired, by the app's own clock", async () => {
  expectWarnings();
  const test = setup();
  const browser = test.browser();

  // Google's ID tokens last an hour. With Google's clock this far behind,
  // the token is past its expiry when the app gets it, by more than the 30
  // seconds of tolerance.
  test.clock.googleLagMs = 61 * 60 * 1000;
  const response = await signIn(test, browser, { email: adminEmail });

  expect(locationOf(response)).toBe("/sign-in?error=failed");
  expect(await me(browser)).toBeNull();

  // With a minute of its hour left, the token is accepted. The clocks of the
  // tests are hours away from the real time, so this also shows that the
  // expiry is judged by the clock the app was given.
  test.clock.googleLagMs = 59 * 60 * 1000;
  expect(locationOf(await signIn(test, browser, { email: adminEmail }))).toBe(
    "/",
  );
});

it("refuses an ID token that is not signed with one of Google's keys", async () => {
  expectWarnings();
  // Another key under the ID of Google's key, as it would look if the token
  // came from somebody who is not Google.
  const { publicKey } = await oauth.generateKeyPair("RS256", {
    extractable: true,
  });
  const otherKey = await crypto.subtle.exportKey("jwk", publicKey);
  if (!("n" in otherKey)) throw new Error("The key was not exported as a JWK");
  let swapKeys = true;
  const test = setup({
    intercept: (google) => async (input, init) => {
      const response = await google(input, init);
      if (!swapKeys || !String(input).endsWith("/oauth2/v3/certs")) {
        return response;
      }
      const { keys } = await response.json<{ keys: JsonWebKey[] }>();
      return Response.json({
        keys: keys.map((key) => ({ ...key, n: otherKey.n })),
      });
    },
  });
  const browser = test.browser();

  const response = await signIn(test, browser, { email: adminEmail });

  expect(locationOf(response)).toBe("/sign-in?error=failed");
  expect(await me(browser)).toBeNull();

  // With Google's own keys the same sign-in succeeds, so it was the
  // signature that failed above.
  swapKeys = false;
  expect(locationOf(await signIn(test, browser, { email: adminEmail }))).toBe(
    "/",
  );
});

it.each([
  [
    // What a token looks like that Google issued to another app. Whoever
    // runs that app, or reads its traffic, could present it to pigy.
    "was issued to another client",
    { aud: "another-app.apps.googleusercontent.com" },
    '"aud"',
  ],
  [
    "was not issued by Google",
    { iss: "https://accounts.example.com" },
    '"iss"',
  ],
])("refuses an ID token that %s", async (_name, changes, claim) => {
  const warn = expectWarnings();
  let changed = true;
  const test = setup({
    intercept: (google) => async (input, init) => {
      const response = await google(input, init);
      if (!String(input).endsWith("/token") || !response.ok) return response;
      // Google's answer with one claim of the ID token changed. The token is
      // signed again with Google's key, so its signature is good.
      const body = await response.json<{ id_token: string }>();
      return Response.json({
        ...body,
        id_token: await resignIdToken(body.id_token, changed ? changes : {}),
      });
    },
  });
  const browser = test.browser();

  const response = await signIn(test, browser, { email: adminEmail });

  expect(locationOf(response)).toBe("/sign-in?error=failed");
  expect(await me(browser)).toBeNull();
  expect(await test.db.select().from(sessions)).toEqual([]);
  // The reason that was logged names the claim.
  expect(String(warn.mock.calls[0]?.[1])).toContain(claim);

  // Signed again with nothing changed, the token is accepted. So it was the
  // one claim that was refused above, not a token that went through
  // `resignIdToken`.
  changed = false;
  expect(locationOf(await signIn(test, browser, { email: adminEmail }))).toBe(
    "/",
  );
});

it("ends the session a browser had when somebody signs in again", async () => {
  const test = setup();
  await invite(test, "ada@example.com");
  const browser = await signedIn(test, { email: adminEmail });
  const first = browser.cookies.get("__Host-pigy_session");

  // Somebody else signs in with the same browser.
  await signIn(test, browser, { email: "ada@example.com" });

  // The new session has a new token, so a token that was known before the
  // sign-in, to whoever, is not the one that is signed in now.
  const second = browser.cookies.get("__Host-pigy_session");
  expect(second).not.toBe(first);
  expect(await me(browser)).toMatchObject({
    user: { email: "ada@example.com" },
  });
  // The old token is not good for anything any more.
  const old = test.browser();
  old.cookies.set("__Host-pigy_session", first ?? "");
  expect(await me(old)).toBeNull();
});
