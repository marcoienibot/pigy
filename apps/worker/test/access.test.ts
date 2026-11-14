import {
  type AllowedEmail,
  allowedEmailListResponseSchema,
  errorResponseSchema,
} from "@pigy/core";
import { expect, it } from "vitest";
import { allowedEmails, sessions } from "../src/db/schema.ts";
import {
  adminEmail,
  type Browser,
  invite,
  locationOf,
  me,
  setup,
  signedIn,
  signIn,
} from "./helpers.ts";

const path = "/api/admin/allowed-emails";

async function list(browser: Browser): Promise<AllowedEmail[]> {
  const response = await browser.fetch(path);
  expect(response.status).toBe(200);
  return allowedEmailListResponseSchema.parse(await response.json())
    .allowedEmails;
}

async function errorOf(response: Response) {
  return errorResponseSchema.parse(await response.json());
}

it("makes the people in ADMIN_EMAILS admins without an invitation", async () => {
  const test = setup({
    env: { ADMIN_EMAILS: " First@Example.com ,second@example.com,," },
  });

  // Nobody is on the allowlist, so these two are how the first admins get
  // in. The variable is typed by hand: spaces, capitals and stray commas
  // must not lock anybody out.
  const first = await signedIn(test, { email: "first@example.com" });
  const second = await signedIn(test, { email: "second@example.com" });

  expect((await me(first))?.role).toBe("admin");
  expect((await me(second))?.role).toBe("admin");
  expect(await test.db.select().from(allowedEmails)).toEqual([]);
});

it("lets nobody in when there are no admins and no invitations", async () => {
  const test = setup({ env: { ADMIN_EMAILS: "" } });
  const browser = test.browser();

  const response = await signIn(test, browser, { email: adminEmail });

  expect(locationOf(response)).toBe("/invite-only");
});

it("is for admins only", async () => {
  const test = setup();
  await invite(test, "member@example.com");
  const member = await signedIn(test, { email: "member@example.com" });
  const nobody = test.browser();
  const requests = [
    { method: "GET", path },
    { method: "POST", path, json: { email: "x@example.com", role: "admin" } },
    {
      method: "PATCH",
      path: `${path}/member@example.com`,
      json: { role: "admin" },
    },
    { method: "DELETE", path: `${path}/${adminEmail}` },
  ];

  for (const { path: requestPath, ...init } of requests) {
    const signedOut = await nobody.fetch(requestPath, init);
    expect(signedOut.status).toBe(401);
    expect((await errorOf(signedOut)).error).toBe("UnauthorizedError");

    const asMember = await member.fetch(requestPath, init);
    expect(asMember.status).toBe(403);
    expect((await errorOf(asMember)).error).toBe("UnauthorizedError");
  }
  // None of the refused requests changed anything.
  expect(await test.db.select().from(allowedEmails)).toMatchObject([
    { email: "member@example.com", role: "member" },
  ]);
});

it("lists the fixed admins and the invitations, with who has signed in", async () => {
  const test = setup();
  await invite(test, "zoe@example.com", "admin");
  await invite(test, "ada@example.com");
  const admin = await signedIn(test, { email: adminEmail });
  await signedIn(test, { email: "ada@example.com" });

  expect(await list(admin)).toEqual([
    { email: adminEmail, role: "admin", fixed: true, signedIn: true },
    { email: "ada@example.com", role: "member", fixed: false, signedIn: true },
    { email: "zoe@example.com", role: "admin", fixed: false, signedIn: false },
  ]);
});

it("invites somebody, who can then sign in", async () => {
  const test = setup();
  const admin = await signedIn(test, { email: adminEmail });
  const guest = test.browser();
  expect(
    locationOf(await signIn(test, guest, { email: "ada@example.com" })),
  ).toBe("/invite-only");

  const response = await admin.fetch(path, {
    method: "POST",
    // Stored in the form that sign-in compares with.
    json: { email: " Ada@Example.com ", role: "member" },
  });

  expect(response.status).toBe(204);
  expect(
    locationOf(await signIn(test, guest, { email: "ada@example.com" })),
  ).toBe("/");
  expect((await me(guest))?.role).toBe("member");
  // Who invited whom is kept.
  const [row] = await test.db.select().from(allowedEmails);
  expect(row?.invitedBy).toBe((await me(admin))?.user.id);
});

it.each([
  ["an invalid email", { email: "not-an-email", role: "member" }],
  ["an unknown role", { email: "ada@example.com", role: "owner" }],
  ["no role", { email: "ada@example.com" }],
  ["something that is not an object", "ada@example.com"],
])("refuses to invite with %s", async (_name, json) => {
  const test = setup();
  const admin = await signedIn(test, { email: adminEmail });

  const response = await admin.fetch(path, { method: "POST", json });

  expect(response.status).toBe(400);
  expect((await errorOf(response)).error).toBe("InvalidInputError");
  expect(await test.db.select().from(allowedEmails)).toEqual([]);
});

it("refuses a body that is not JSON", async () => {
  const test = setup();
  const admin = await signedIn(test, { email: adminEmail });

  const response = await admin.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  expect(response.status).toBe(400);
  expect((await errorOf(response)).error).toBe("InvalidInputError");
});

it("refuses to invite somebody twice", async () => {
  const test = setup();
  await invite(test, "ada@example.com", "admin");
  const admin = await signedIn(test, { email: adminEmail });

  for (const email of ["ada@example.com", adminEmail]) {
    const response = await admin.fetch(path, {
      method: "POST",
      json: { email, role: "member" },
    });
    expect(response.status).toBe(409);
    expect((await errorOf(response)).error).toBe("InvalidInputError");
  }
  // The second invitation must not have replaced the first one's role.
  expect(await test.db.select().from(allowedEmails)).toMatchObject([
    { email: "ada@example.com", role: "admin" },
  ]);
});

it("applies a change of role to the very next request", async () => {
  const test = setup();
  await invite(test, "ada@example.com");
  const admin = await signedIn(test, { email: adminEmail });
  const ada = await signedIn(test, { email: "ada@example.com" });
  expect((await ada.fetch(path)).status).toBe(403);

  const promoted = await admin.fetch(`${path}/ada@example.com`, {
    method: "PATCH",
    json: { role: "admin" },
  });

  expect(promoted.status).toBe(204);
  // The same session, without signing in again.
  expect((await me(ada))?.role).toBe("admin");
  expect((await ada.fetch(path)).status).toBe(200);

  await admin.fetch(`${path}/ada@example.com`, {
    method: "PATCH",
    json: { role: "member" },
  });
  expect((await ada.fetch(path)).status).toBe(403);
});

it("signs somebody out everywhere when their invitation is removed", async () => {
  const test = setup();
  await invite(test, "ada@example.com");
  await invite(test, "bob@example.com");
  const admin = await signedIn(test, { email: adminEmail });
  const phone = await signedIn(test, { email: "ada@example.com" });
  const laptop = await signedIn(test, { email: "ada@example.com" });
  const bob = await signedIn(test, { email: "bob@example.com" });

  const response = await admin.fetch(
    // The address in the path is matched like every other address.
    `${path}/${encodeURIComponent("Ada@Example.com")}`,
    { method: "DELETE" },
  );

  expect(response.status).toBe(204);
  // Checked in the database first: the sessions are gone at once, not when
  // they are next used.
  expect(await test.db.select().from(sessions)).toHaveLength(2);
  expect(await me(phone)).toBeNull();
  expect(await me(laptop)).toBeNull();
  // Nobody else is affected.
  expect(await me(bob)).not.toBeNull();
  expect(await me(admin)).not.toBeNull();
  // And Ada cannot sign in again.
  expect(
    locationOf(await signIn(test, phone, { email: "ada@example.com" })),
  ).toBe("/invite-only");
});

it("ends a session whose invitation is gone, even if the session was left behind", async () => {
  const test = setup();
  await invite(test, "ada@example.com");
  const ada = await signedIn(test, { email: "ada@example.com" });

  // The invitation disappears without the sessions being deleted, as when
  // an address is taken out of ADMIN_EMAILS.
  await test.db.delete(allowedEmails);

  expect(await me(ada)).toBeNull();
  expect(await test.db.select().from(sessions)).toEqual([]);
});

it("answers 404 for an address that is not on the list", async () => {
  const test = setup();
  const admin = await signedIn(test, { email: adminEmail });

  for (const init of [
    { method: "PATCH", json: { role: "admin" } },
    { method: "DELETE" },
  ]) {
    const response = await admin.fetch(`${path}/nobody@example.com`, init);
    expect(response.status).toBe(404);
    expect((await errorOf(response)).error).toBe("NotFoundError");
  }
});

it("does not let the admins from ADMIN_EMAILS be changed or removed", async () => {
  const test = setup({
    env: { ADMIN_EMAILS: `${adminEmail},second@example.com` },
  });
  // A row for the same address, as it would be left over from before the
  // address was put into the variable.
  await invite(test, "second@example.com", "member");
  const admin = await signedIn(test, { email: adminEmail });
  const second = await signedIn(test, { email: "second@example.com" });

  const demoted = await admin.fetch(`${path}/second@example.com`, {
    method: "PATCH",
    json: { role: "member" },
  });
  const removed = await admin.fetch(`${path}/second@example.com`, {
    method: "DELETE",
  });

  expect(demoted.status).toBe(400);
  expect(removed.status).toBe(400);
  expect((await errorOf(removed)).error).toBe("InvalidInputError");
  // The variable wins over the row, and the session is untouched.
  expect((await me(second))?.role).toBe("admin");
  expect(await list(admin)).toEqual([
    { email: adminEmail, role: "admin", fixed: true, signedIn: true },
    { email: "second@example.com", role: "admin", fixed: true, signedIn: true },
  ]);
});

it("does not let admins change or remove their own entry", async () => {
  const test = setup();
  await invite(test, "ada@example.com", "admin");
  const ada = await signedIn(test, { email: "ada@example.com" });

  // One slip here would lock an admin out of the page that could undo it.
  const demoted = await ada.fetch(`${path}/ada@example.com`, {
    method: "PATCH",
    json: { role: "member" },
  });
  const removed = await ada.fetch(`${path}/ada@example.com`, {
    method: "DELETE",
  });

  expect(demoted.status).toBe(400);
  expect(removed.status).toBe(400);
  expect((await me(ada))?.role).toBe("admin");
});
