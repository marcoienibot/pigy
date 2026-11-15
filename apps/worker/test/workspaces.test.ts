import { workspaceListResponseSchema } from "@pigy/core";
import { expect, it } from "vitest";
import { users, workspaces } from "../src/db/schema.ts";
import {
  adminEmail,
  type Browser,
  invite,
  setup,
  signedIn,
} from "./helpers.ts";

async function list(browser: Browser) {
  const response = await browser.fetch("/api/workspaces");
  expect(response.status).toBe(200);
  return workspaceListResponseSchema.parse(await response.json()).workspaces;
}

it("gives somebody a live and a sandbox workspace the first time they ask", async () => {
  const test = setup();
  const browser = await signedIn(test, { email: adminEmail });
  // Nothing is created at sign-in.
  expect(await test.db.select().from(workspaces)).toEqual([]);

  const listed = await list(browser);

  expect(listed.map(({ environment }) => environment)).toEqual([
    "live",
    "sandbox",
  ]);
  const [user] = await test.db.select().from(users);
  const stored = await test.db.select().from(workspaces);
  expect(stored.map(({ id }) => id).sort()).toEqual(
    listed.map(({ id }) => id).sort(),
  );
  expect(stored.map(({ ownerId }) => ownerId)).toEqual([user?.id, user?.id]);
});

it("lists the same workspaces every time", async () => {
  const test = setup();
  const browser = await signedIn(test, { email: adminEmail });

  // The first two requests arrive together, as when two tabs open at once.
  // Each finds no workspaces and tries to create them.
  const [first, second] = await Promise.all([list(browser), list(browser)]);
  const third = await list(browser);

  expect(second).toEqual(first);
  expect(third).toEqual(first);
  expect(await test.db.select().from(workspaces)).toHaveLength(2);
});

it("gives everybody workspaces of their own", async () => {
  const test = setup();
  await invite(test, "member@example.com");
  const admin = await signedIn(test, { email: adminEmail });
  const member = await signedIn(test, { email: "member@example.com" });

  const ofAdmin = (await list(admin)).map(({ id }) => id);
  const ofMember = (await list(member)).map(({ id }) => id);

  expect(new Set([...ofAdmin, ...ofMember]).size).toBe(4);
});

it("refuses to list workspaces without a session", async () => {
  const test = setup();

  const response = await test.browser().fetch("/api/workspaces");

  expect(response.status).toBe(401);
  // Asking is what creates workspaces. It must not for a stranger.
  expect(await test.db.select().from(workspaces)).toEqual([]);
});
