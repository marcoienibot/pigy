import { errorResponseSchema } from "@pigy/core";
import { expect, it } from "vitest";
import { sessions } from "../src/db/schema.ts";
import { adminEmail, me, setup, signedIn } from "./helpers.ts";

const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;
const cookieName = "__Host-pigy_session";

it("answers a request without a session with a 401", async () => {
  const response = await setup().browser().fetch("/api/me");

  expect(response.status).toBe(401);
  expect(errorResponseSchema.parse(await response.json()).error).toBe(
    "UnauthorizedError",
  );
  // What the API answers depends on who asks, so nothing may keep a copy.
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});

it("stores a hash of the session secret, not the secret", async () => {
  const test = setup();
  const browser = await signedIn(test, { email: adminEmail });

  const [id, secret] = (browser.cookies.get(cookieName) ?? "").split(".");
  const [row] = await test.db.select().from(sessions);

  expect(row?.id).toBe(id);
  // Whoever reads the table must not be able to make a cookie from it.
  expect(JSON.stringify(row)).not.toContain(secret);
});

it("refuses a session token with the right ID and a wrong secret", async () => {
  const test = setup();
  const browser = await signedIn(test, { email: adminEmail });
  const [id, secret = ""] = (browser.cookies.get(cookieName) ?? "").split(".");

  // The ID is not secret. Only the secret proves that the cookie is the one
  // that was handed out.
  const forged = test.browser();
  forged.cookies.set(cookieName, `${id}.${"0".repeat(secret.length)}`);

  expect(await me(forged)).toBeNull();
  // The session is still good for its owner: a wrong guess must not be a
  // way to sign somebody else out.
  expect(await me(browser)).not.toBeNull();
});

it.each(["", "no-dot", "a.b.c", "."])(
  "refuses the malformed session token %j",
  async (token) => {
    const test = setup();
    const browser = test.browser();
    browser.cookies.set(cookieName, token);

    expect(await me(browser)).toBeNull();
  },
);

it("ends a session that was not used for 30 days", async () => {
  const test = setup();
  const browser = await signedIn(test, { email: adminEmail });

  test.advance(30 * dayMs - 1000);
  // Looked up straight from the database: asking the app would count as
  // using the session and renew it.
  const [{ expiresAt } = {}] = await test.db.select().from(sessions);
  expect(expiresAt && expiresAt > test.clock.time).toBe(true);

  test.advance(1000);
  expect(await me(browser)).toBeNull();
  // An expired session is removed, and the browser is told to drop the
  // cookie.
  expect(await test.db.select().from(sessions)).toEqual([]);
  expect(browser.cookies.has(cookieName)).toBe(false);
});

it("keeps a session alive for as long as it is used", async () => {
  const test = setup();
  const browser = await signedIn(test, { email: adminEmail });

  // Used every 20 days, for 100 days: much longer than a session lasts.
  for (let i = 0; i < 5; i++) {
    test.advance(20 * dayMs);
    expect(await me(browser)).not.toBeNull();
  }
});

it("renews a session at most once a day", async () => {
  const test = setup();
  const browser = await signedIn(test, { email: adminEmail });
  const expiry = async () =>
    (await test.db.select().from(sessions))[0]?.expiresAt.getTime();
  const signedInAt = test.clock.time.getTime();

  // Used after 23 hours: the expiry does not move and no cookie is sent,
  // because a write on every request is what the threshold avoids.
  test.advance(23 * hourMs);
  await browser.fetch("/api/me");
  expect(await expiry()).toBe(signedInAt + 30 * dayMs);
  expect(browser.lastSetCookies).toEqual([]);

  // Used after 25 hours: the session has 30 days again, and so has the
  // cookie, or the browser would drop it before the session ends.
  test.advance(2 * hourMs);
  await browser.fetch("/api/me");
  expect(await expiry()).toBe(test.clock.time.getTime() + 30 * dayMs);
  expect(browser.lastSetCookies).toHaveLength(1);
  expect(browser.lastSetCookies[0]).toMatch(/^__Host-pigy_session=/);
  expect(browser.lastSetCookies[0]).toContain(`Max-Age=${30 * 24 * 60 * 60}`);
  expect(browser.lastSetCookies[0]).toContain("HttpOnly");
});

it("signs out by deleting the session on the server", async () => {
  const test = setup();
  const browser = await signedIn(test, { email: adminEmail });
  const token = browser.cookies.get(cookieName) ?? "";

  const response = await browser.fetch("/api/auth/sign-out", {
    method: "POST",
  });

  expect(response.status).toBe(204);
  expect(browser.cookies.has(cookieName)).toBe(false);
  // A copy of the cookie made before signing out must be worthless too.
  const copy = test.browser();
  copy.cookies.set(cookieName, token);
  expect(await me(copy)).toBeNull();
  expect(await test.db.select().from(sessions)).toEqual([]);
});

it("signs out only the session of the request", async () => {
  const test = setup();
  const phone = await signedIn(test, { email: adminEmail });
  const laptop = await signedIn(test, { email: adminEmail });

  await phone.fetch("/api/auth/sign-out", { method: "POST" });

  expect(await me(phone)).toBeNull();
  expect(await me(laptop)).not.toBeNull();
});

// A page on another site can make the browser send a request with the
// session cookie. The Origin header tells such a request apart.
it.each([
  ["another site", { Origin: "https://evil.example" }],
  ["the same host over HTTP", { Origin: "http://pigy.test" }],
  ["a sandboxed page", { Origin: "null" }],
])("refuses a sign-out sent by %s", async (_name, headers) => {
  const test = setup();
  const browser = await signedIn(test, { email: adminEmail });

  const response = await browser.fetch("/api/auth/sign-out", {
    method: "POST",
    headers,
  });

  expect(response.status).toBe(403);
  expect(errorResponseSchema.parse(await response.json()).error).toBe(
    "UnauthorizedError",
  );
  expect(await me(browser)).not.toBeNull();
});

it("refuses a request that changes something and has no Origin", async () => {
  const test = setup();
  const browser = await signedIn(test, { email: adminEmail });

  // Built without the helper's Origin header. Browsers always send it with
  // a POST, so its absence means the request is not from pigy's pages.
  const response = await browser.fetch("/api/admin/allowed-emails", {
    method: "POST",
    json: { email: "eve@example.com", role: "admin" },
    headers: { Origin: null },
  });

  expect(response.status).toBe(403);
});

it("removes sessions that have expired when their owner signs in again", async () => {
  const test = setup();
  await signedIn(test, { email: adminEmail });
  test.advance(31 * dayMs);

  await signedIn(test, { email: adminEmail });

  // Only the new session is left. The old one was never used again, so
  // nothing else would have removed its row.
  const rows = await test.db.select().from(sessions);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.createdAt).toEqual(test.clock.time);
});
