import { env } from "cloudflare:workers";
import { apiKeyListResponseSchema, maxApiKeys } from "@pigy/core";
import { expect, it } from "vitest";
import { lastUsedEveryMs } from "../src/api/keys.ts";
import { apiClient, makeKey, startedApi } from "./api.ts";
import {
  adminEmail,
  type Browser,
  breakDatabase,
  expectErrors,
  invite,
  locationOf,
  logged,
  me,
  signedIn,
  signIn,
} from "./helpers.ts";
import { workspaceIds } from "./sync-client.ts";

/**
 * The keys of the public API: how a person makes, lists and revokes them,
 * and when a key is taken.
 */

const minute = 60 * 1000;

async function listed(browser: Browser, workspaceId: string) {
  const response = await browser.fetch(
    `/api/workspaces/${workspaceId}/api-keys`,
  );
  expect(response.status).toBe(200);
  return apiKeyListResponseSchema.parse(await response.json()).apiKeys;
}

const revoke = (browser: Browser, workspaceId: string, keyId: string) =>
  browser.fetch(`/api/workspaces/${workspaceId}/api-keys/${keyId}`, {
    method: "DELETE",
  });

/** What the database has of the keys, every column. */
const stored = () =>
  env.DB.prepare("select * from api_key order by created_at").all<
    Record<string, unknown>
  >();

it("makes a key that says its environment, shows its secret once and stores a hash", async () => {
  const { test, browser, workspaces } = await startedApi();

  const live = await makeKey(browser, workspaces.live, { name: "Live script" });
  const sandbox = await makeKey(browser, workspaces.sandbox, {
    name: "Sandbox script",
    scopes: ["posts:read"],
  });
  expect(live.secret).toMatch(/^pigy_live_[0-9a-f]{16}_[0-9a-f]{64}$/);
  expect(sandbox.secret).toMatch(/^pigy_test_[0-9a-f]{16}_[0-9a-f]{64}$/);
  // What the person sees of a key later begins like the key, and stops
  // before its secret.
  expect(live.secret.startsWith(live.apiKey.prefix)).toBe(true);
  expect(live.apiKey.prefix).toMatch(/^pigy_live_[0-9a-f]{8}$/);

  // Each workspace lists its own key, and no answer has the secret again.
  const keys = await listed(browser, workspaces.live);
  expect(keys).toEqual([
    {
      id: live.apiKey.id,
      name: "Live script",
      prefix: live.apiKey.prefix,
      scopes: ["posts:read", "posts:write", "channels:read"],
      createdAt: test.clock.time.getTime(),
      lastUsedAt: null,
      expiresAt: null,
    },
  ]);
  expect(
    (await listed(browser, workspaces.sandbox)).map(({ name }) => name),
  ).toEqual(["Sandbox script"]);

  // Nothing that is stored is the secret, or holds it.
  const { results } = await stored();
  const secrets = [live.secret, sandbox.secret].map((key) => key.slice(-64));
  for (const secret of secrets) {
    expect(JSON.stringify(results)).not.toContain(secret);
  }
});

it("refuses a key that it could not honour", async () => {
  const { test, browser, workspaces } = await startedApi();
  const make = (json: unknown) =>
    browser.fetch(`/api/workspaces/${workspaces.live}/api-keys`, {
      method: "POST",
      json,
    });
  const key = { name: "A script", scopes: ["posts:read"], expiresAt: null };

  // The scope is declared for the day that images exist.
  const media = await make({ ...key, scopes: ["media:write"] });
  expect(media.status).toBe(400);
  expect(await media.json()).toMatchObject({
    error: "InvalidInputError",
    field: "scopes",
    message: expect.stringContaining("media:write"),
  });

  const past = await make({ ...key, expiresAt: test.clock.time.getTime() });
  expect(past.status).toBe(400);
  expect(await past.json()).toMatchObject({ field: "expiresAt" });

  for (const wrong of [
    { ...key, name: "  " },
    { ...key, scopes: [] },
    { ...key, scopes: ["posts:read", "posts:read"] },
    { ...key, scopes: ["everything"] },
    { ...key, workspaceId: workspaces.sandbox },
  ]) {
    expect((await make(wrong)).status).toBe(400);
  }
  expect(await listed(browser, workspaces.live)).toEqual([]);
});

it("keeps a workspace to a number of keys, which revoking makes room in", async () => {
  const { browser, workspaces } = await startedApi();
  const keys = [];
  for (let index = 0; index < maxApiKeys; index += 1) {
    keys.push(await makeKey(browser, workspaces.live));
  }
  const make = () =>
    browser.fetch(`/api/workspaces/${workspaces.live}/api-keys`, {
      method: "POST",
      json: { name: "One more", scopes: ["posts:read"], expiresAt: null },
    });
  expect((await make()).status).toBe(409);

  const [first] = keys;
  if (!first) throw new Error("No key was made");
  expect((await revoke(browser, workspaces.live, first.apiKey.id)).status).toBe(
    204,
  );
  expect((await make()).status).toBe(201);
});

it("lets only the person who is signed in manage the keys of their workspace", async () => {
  const { test, browser, workspaces } = await startedApi();
  const { apiKey, secret } = await makeKey(browser, workspaces.live);
  const path = `/api/workspaces/${workspaces.live}/api-keys`;
  const body = { name: "Another", scopes: ["posts:read"], expiresAt: null };

  // A key is no session: it cannot list the keys, make one or revoke one.
  const withKey = { Authorization: `Bearer ${secret}`, Origin: null };
  const script = test.browser();
  expect((await script.fetch(path, { headers: withKey })).status).toBe(401);
  expect(
    (await script.fetch(path, { method: "POST", json: body, headers: withKey }))
      .status,
  ).toBe(401);
  expect(
    (
      await script.fetch(`${path}/${apiKey.id}`, {
        method: "DELETE",
        headers: withKey,
      })
    ).status,
  ).toBe(401);

  // A page of another site, in the browser of the person.
  const forged = await browser.fetch(path, {
    method: "POST",
    json: body,
    headers: { Origin: "https://elsewhere.example" },
  });
  expect(forged.status).toBe(403);

  // Somebody else, of whom the workspace is not: it is not there for them,
  // and neither is its key.
  await invite(test, "member@example.com");
  const other = await signedIn(test, { email: "member@example.com" });
  expect((await other.fetch(path)).status).toBe(404);
  expect((await other.fetch(path, { method: "POST", json: body })).status).toBe(
    404,
  );
  const theirs = await workspaceIds(other);
  expect((await revoke(other, theirs.live, apiKey.id)).status).toBe(404);

  expect((await listed(browser, workspaces.live)).map(({ id }) => id)).toEqual([
    apiKey.id,
  ]);
});

it("takes no key that is unknown, wrong, revoked or expired", async () => {
  const { test, browser, workspaces } = await startedApi();
  const hour = 60 * minute;
  const { apiKey, secret } = await makeKey(browser, workspaces.live);
  const lasting = await makeKey(browser, workspaces.live, {
    expiresAt: test.clock.time.getTime() + hour,
  });
  const statusOf = async (key: string) =>
    (await apiClient(test, key).call("/account")).status;
  expect(await statusOf(secret)).toBe(200);
  expect(await statusOf(lasting.secret)).toBe(200);

  const flipped = secret.endsWith("0") ? "1" : "0";
  for (const wrong of [
    // The key of nobody, in the right form.
    `pigy_live_${"0".repeat(16)}_${"0".repeat(64)}`,
    // The right key with another secret.
    `${secret.slice(0, -1)}${flipped}`,
    // The right key, said to be of the other environment.
    secret.replace("pigy_live_", "pigy_test_"),
    secret.toUpperCase(),
    `${secret}0`,
    "",
  ]) {
    const refused = await apiClient(test, wrong).refused("/account", {}, 401);
    expect(refused.error).toBe("UnauthorizedError");
  }
  // No key at all, and a scheme that is not a key's.
  const none = await test.browser().fetch("/api/v1/account");
  expect(none.status).toBe(401);
  expect(none.headers.get("WWW-Authenticate")).toBe("Bearer");
  const basic = await test.browser().fetch("/api/v1/account", {
    headers: { Authorization: `Basic ${btoa(`${secret}:`)}` },
  });
  expect(basic.status).toBe(401);

  // An expired key stops at its time, not before.
  test.advance(hour - 1);
  expect(await statusOf(lasting.secret)).toBe(200);
  test.advance(1);
  expect(
    (await apiClient(test, lasting.secret).refused("/account", {}, 401))
      .message,
  ).toBe("This API key has expired");

  expect((await revoke(browser, workspaces.live, apiKey.id)).status).toBe(204);
  expect(
    (await apiClient(test, secret).refused("/account", {}, 401)).message,
  ).toBe("This API key was revoked");
  // Revoked once: there is no such key to revoke again.
  expect((await revoke(browser, workspaces.live, apiKey.id)).status).toBe(404);
  expect(await listed(browser, workspaces.live)).toHaveLength(1);
});

it("stops the keys of a person who is no longer invited, and takes them again when they are", async () => {
  const { test, browser } = await startedApi();
  await invite(test, "member@example.com");
  const member = await signedIn(test, { email: "member@example.com" });
  const { secret } = await makeKey(member, (await workspaceIds(member)).live);
  const api = apiClient(test, secret);
  await api.ok("/account");

  const removed = await browser.fetch(
    "/api/admin/allowed-emails/member%40example.com",
    { method: "DELETE" },
  );
  expect(removed.status).toBe(204);
  expect((await api.refused("/account", {}, 401)).message).toBe(
    "The owner of this API key no longer has access",
  );
  // Nothing was done to the key: the owner is looked up with every
  // request, so it is good again when they are.
  await invite(test, "member@example.com");
  await api.ok("/account");
});

it("revokes the keys of an account whose address Google no longer verifies, with its sessions", async () => {
  const { test } = await startedApi();
  await invite(test, "member@example.com");
  const account = { email: "member@example.com", sub: "1001" };
  const member = await signedIn(test, account);
  const ids = await workspaceIds(member);
  const live = apiClient(test, (await makeKey(member, ids.live)).secret);
  const sandbox = apiClient(test, (await makeKey(member, ids.sandbox)).secret);
  await live.ok("/account");
  await sandbox.ok("/account");

  // Google says at a later sign-in that the address is not verified. The
  // address stays stored and stays invited, which is all that a key is
  // matched against: without the revocation both keys would go on.
  const refused = await signIn(test, test.browser(), {
    ...account,
    verified: false,
  });
  expect(locationOf(refused)).toBe("/sign-in?error=email_not_verified");
  expect(await me(member)).toBeNull();
  for (const api of [live, sandbox]) {
    expect((await api.refused("/account", {}, 401)).message).toBe(
      "This API key was revoked",
    );
  }

  // They do not come back when the account signs in again: the person
  // makes new ones.
  const back = await signedIn(test, account);
  await live.refused("/account", {}, 401);
  expect(await listed(back, ids.live)).toEqual([]);
  await apiClient(test, (await makeKey(back, ids.live)).secret).ok("/account");
});

it("revokes the keys of an account whose address another Google account has taken over", async () => {
  const { test } = await startedApi();
  await invite(test, "member@example.com");
  const before = await signedIn(test, {
    email: "member@example.com",
    sub: "1001",
  });
  const { secret } = await makeKey(before, (await workspaceIds(before)).live);
  const api = apiClient(test, secret);
  await api.ok("/account");

  // The address is given to somebody new, who signs in with it. The
  // account that had it is still stored with it.
  const after = await signedIn(test, {
    email: "member@example.com",
    sub: "2002",
  });
  expect(await me(before)).toBeNull();
  expect((await api.refused("/account", {}, 401)).message).toBe(
    "This API key was revoked",
  );
  // The new account has workspaces and keys of its own, which work.
  const theirs = await makeKey(after, (await workspaceIds(after)).live);
  await apiClient(test, theirs.secret).ok("/account");
  await api.refused("/account", {}, 401);
});

it("revokes the keys of an account that Google reports with another address, which is not invited", async () => {
  const { test } = await startedApi();
  await invite(test, "member@example.com");
  const member = await signedIn(test, {
    email: "member@example.com",
    sub: "1001",
  });
  const { secret } = await makeKey(member, (await workspaceIds(member)).live);
  const api = apiClient(test, secret);

  // The account is stored with the address that is invited, and no
  // longer has it.
  const refused = await signIn(test, test.browser(), {
    email: "renamed@example.com",
    sub: "1001",
  });
  expect(locationOf(refused)).toBe("/invite-only");
  expect((await api.refused("/account", {}, 401)).message).toBe(
    "This API key was revoked",
  );
});

it("keeps the keys of somebody who is only no longer invited and tries to sign in: they stop, and work again", async () => {
  const { test, browser } = await startedApi();
  await invite(test, "member@example.com");
  const account = { email: "member@example.com", sub: "1001" };
  const member = await signedIn(test, account);
  const { secret } = await makeKey(member, (await workspaceIds(member)).live);
  const api = apiClient(test, secret);

  const removed = await browser.fetch(
    "/api/admin/allowed-emails/member%40example.com",
    { method: "DELETE" },
  );
  expect(removed.status).toBe(204);
  // The sign-in is refused, and Google has verified the address that the
  // account is stored with: nothing is lost but the invitation.
  expect(locationOf(await signIn(test, test.browser(), account))).toBe(
    "/invite-only",
  );
  expect((await api.refused("/account", {}, 401)).message).toBe(
    "The owner of this API key no longer has access",
  );
  await invite(test, "member@example.com");
  await api.ok("/account");
});

it("stops the keys of an admin who is taken out of ADMIN_EMAILS, which no route hears of", async () => {
  const { test, browser, workspaces } = await startedApi();
  const { secret } = await makeKey(browser, workspaces.live);
  const api = apiClient(test, secret);
  await api.ok("/account");

  test.redeploy({ ADMIN_EMAILS: "somebody-else@example.com" });
  await api.refused("/account", {}, 401);
  test.redeploy({ ADMIN_EMAILS: adminEmail });
  await api.ok("/account");
});

it("writes down when a key was last used at most once a minute", async () => {
  const { test, browser, workspaces } = await startedApi();
  const { apiKey, secret } = await makeKey(browser, workspaces.live);
  const api = apiClient(test, secret);
  const lastUsed = async () =>
    (await listed(browser, workspaces.live)).find(({ id }) => id === apiKey.id)
      ?.lastUsedAt;
  expect(await lastUsed()).toBeNull();

  test.advance(minute);
  const first = test.clock.time.getTime();
  await api.ok("/account");
  expect(await lastUsed()).toBe(first);

  // Used again within the minute: nothing is written.
  test.advance(lastUsedEveryMs - 1);
  await api.ok("/account");
  expect(await lastUsed()).toBe(first);

  test.advance(1);
  await api.ok("/account");
  expect(await lastUsed()).toBe(first + lastUsedEveryMs);
});

it("logs nothing of a key when the database fails under it", async () => {
  const { test, browser, workspaces } = await startedApi();
  const { secret } = await makeKey(browser, workspaces.live);
  const errors = expectErrors();
  const values: unknown[] = [];
  breakDatabase((sql) => sql.includes('from "api_key"'), values);

  const failed = await apiClient(test, secret).refused("/account", {}, 500);
  expect(failed.message).toBe("Something went wrong");

  // The statement did fail, and was logged. What was logged has neither
  // the key nor anything that the statement was run with.
  expect(values.length).toBeGreaterThan(0);
  const log = logged(errors.mock.calls);
  expect(log).toContain("api_key");
  expect(log).not.toContain(secret);
  expect(log).not.toContain(secret.slice(-64));
});
