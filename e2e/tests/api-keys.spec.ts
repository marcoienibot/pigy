import {
  draftRow,
  expectSync,
  expectWorkspace,
  openScreen,
  overflowOf,
  switchTo,
} from "../app.ts";
import { expect, type Page, test } from "../fixtures.ts";

/**
 * Settings → API: a person makes a key, sees it once, a script uses it
 * against the built Worker, and the person revokes it.
 */

/** Opens the keys of the workspace that `page` shows. */
async function openKeys(page: Page) {
  await openScreen(page, "Settings");
  await page
    .getByRole("navigation", { name: "Settings" })
    .getByRole("link", { name: "API" })
    .click();
  await expect(page.getByRole("heading", { name: "API keys" })).toBeVisible();
}

const keyRows = (page: Page) =>
  page.getByRole("list", { name: "API keys" }).getByRole("listitem");

/** Makes a key named `name` and returns it, as the screen shows it once. */
async function makeKey(page: Page, name: string): Promise<string> {
  await page.getByRole("textbox", { name: "Name of the new key" }).fill(name);
  await page.getByRole("button", { name: "Create key" }).click();
  const shown = page.getByRole("region", { name: "Your new key" });
  await expect(shown).toContainText("only time");
  const key = await shown
    .getByRole("textbox", { name: "The new key" })
    .inputValue();
  return key;
}

/**
 * Calls the API from the page as a script would: with the key, and
 * without the cookie of whoever is signed in, which the page leaves out.
 */
function call(
  page: Page,
  key: string,
  path: string,
  init: { method?: string; json?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  return page.evaluate(
    async ({ key, path, method, json }) => {
      const response = await fetch(`/api/v1${path}`, {
        method,
        credentials: "omit",
        headers: {
          Authorization: `Bearer ${key}`,
          ...(json !== undefined && { "Content-Type": "application/json" }),
        },
        ...(json !== undefined && { body: JSON.stringify(json) }),
      });
      return {
        status: response.status,
        body: response.status === 204 ? null : await response.json(),
      };
    },
    { key, path, method: init.method ?? "GET", json: init.json },
  );
}

test("makes a key that is shown once, which a script creates a draft with, and revokes it", async ({
  ownPage: page,
}) => {
  // Close to the time that a test has: a person of its own, a key that
  // is made, used and revoked, and the page loaded again in between.
  test.slow();
  await openKeys(page);
  await expect(page.getByText("The sandbox has no API keys.")).toBeVisible();

  // Everybody starts in the sandbox, so the key is one of the sandbox:
  // it says so, and the screen says what that means.
  const key = await makeKey(page, "My script");
  expect(key).toMatch(/^pigy_test_[0-9a-f]{16}_[0-9a-f]{64}$/);
  await expect(page.getByText("simulated networks only")).toBeVisible();
  // A phone has room for the key, the warning and the buttons.
  expect(await overflowOf(page)).toBe(0);

  // The list has the key by its name and its beginning, without the rest.
  const row = keyRows(page).filter({ hasText: "My script" });
  await expect(row).toContainText(`${key.slice(0, 18)}…`);
  await expect(row).toContainText("posts:read, posts:write, channels:read");
  await expect(row).toContainText("Never used");
  await expect(row).toContainText("Never expires");
  await expect(row).not.toContainText(key.slice(-64));

  // Once the person says that they have it, it is nowhere on the page,
  // and loading the page again does not bring it back.
  await page.getByRole("button", { name: "I have copied it" }).click();
  await expect(page.getByRole("region", { name: "Your new key" })).toHaveCount(
    0,
  );
  await expect(page.locator("body")).not.toContainText(key.slice(-64));
  await page.reload();
  await expect(keyRows(page)).toHaveCount(1);
  await expect(page.locator("body")).not.toContainText(key.slice(-64));

  // A script uses the key: it is the person's, in their sandbox.
  const account = await call(page, key, "/account");
  expect(account.status).toBe(200);
  expect(account.body).toMatchObject({
    workspace: { environment: "sandbox" },
    apiKey: { name: "My script" },
  });
  const created = await call(page, key, "/posts", {
    method: "POST",
    json: { text: "Written by a script", saveToDraft: true },
  });
  expect(created.status).toBe(201);

  // The draft is in the app, which heard of it as it was made: the page
  // is not loaded again for it.
  await openScreen(page, "Drafts");
  await expect(draftRow(page, "Written by a script")).toBeVisible();
  await expectSync(page, "Synced");

  // The cookie of the person is no key: a page cannot call the API with
  // it, whatever it sends besides.
  const withCookie = await page.evaluate(async () => {
    const response = await fetch("/api/v1/posts", { credentials: "include" });
    return response.status;
  });
  expect(withCookie).toBe(401);

  // The list of the keys says that the key was used. Revoking asks first,
  // and "Cancel" revokes nothing.
  await openKeys(page);
  await expect(keyRows(page).first()).toContainText("Last used just now");
  await page.getByRole("button", { name: "Revoke My script" }).click();
  const question = page.getByRole("alertdialog");
  await expect(question).toContainText("stops working at once");
  await question.getByRole("button", { name: "Cancel" }).click();
  expect((await call(page, key, "/account")).status).toBe(200);

  await page.getByRole("button", { name: "Revoke My script" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Revoke" })
    .click();
  await expect(page.getByText("The sandbox has no API keys.")).toBeVisible();
  const refused = await call(page, key, "/account");
  expect(refused.status).toBe(401);
  expect(refused.body).toEqual({
    error: "UnauthorizedError",
    message: "This API key was revoked",
  });
});

test("keeps the keys of the two workspaces apart, and a new key off the screen of the other", async ({
  ownPage: page,
}) => {
  // Two keys, each used by a script, in two workspaces: close to the
  // time that a test has.
  test.slow();
  await openKeys(page);
  const sandboxKey = await makeKey(page, "Sandbox script");

  // The key that was just made is still on screen with its secret when
  // the person changes workspaces.
  const shown = page
    .getByRole("region", { name: "Your new key" })
    .getByRole("textbox", { name: "The new key" });
  await expect(shown).toHaveValue(sandboxKey);
  await switchTo(page, "Live");
  await expectWorkspace(page, "Live");
  // It goes with the screen, which is made anew for the other workspace.
  // Looked at as the switch leaves the page: going to the screen again
  // would show a new one whatever the switch had left.
  await expect(page.getByRole("heading", { name: "API keys" })).toBeVisible();
  await expect(
    page.getByText("The live workspace has no API keys."),
  ).toBeVisible();
  // The key was the value of a field, which is no text of the page: the
  // field has to be gone, and the region that it was in.
  await expect(shown).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Your new key" })).toHaveCount(
    0,
  );
  await expect(page.locator("body")).not.toContainText(sandboxKey.slice(-64));
  await expect(page.getByText("posts to your real accounts")).toBeVisible();

  const liveKey = await makeKey(page, "Live script");
  expect(liveKey).toMatch(/^pigy_live_/);
  await expect(keyRows(page)).toHaveCount(1);
  expect((await call(page, liveKey, "/account")).body).toMatchObject({
    workspace: { environment: "live" },
  });

  // What the form refuses, it says next to itself.
  await page.getByRole("button", { name: "I have copied it" }).click();
  await page.getByRole("button", { name: "Create key" }).click();
  await expect(page.getByRole("alert")).toContainText("Give the key a name");
  await page
    .getByRole("textbox", { name: "Name of the new key" })
    .fill("Reader");
  for (const scope of ["Read posts", "Create, change", "Read the connected"]) {
    await page.getByRole("checkbox", { name: new RegExp(scope) }).uncheck();
  }
  await page.getByRole("button", { name: "Create key" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Choose what the key may do",
  );

  // A key with one scope and an end, which the row then says.
  await page.getByRole("checkbox", { name: /Read posts/ }).check();
  await page
    .getByRole("combobox", { name: "How long the key works" })
    .selectOption({ label: "Expires in 30 days" });
  await page.getByRole("button", { name: "Create key" }).click();
  await expect(
    page.getByRole("region", { name: "Your new key" }),
  ).toBeVisible();
  const reader = keyRows(page).filter({ hasText: "Reader" });
  await expect(reader).toContainText("posts:read");
  await expect(reader).not.toContainText("posts:write");
  await expect(reader).toContainText("Expires on");
  expect(await overflowOf(page)).toBe(0);
});

test("serves the page that describes the API, and its document", async ({
  page,
  request,
}) => {
  // To anybody: nothing of anybody's is in either. The service worker of
  // the app leaves the address to the server, as every path under /api/.
  await page.goto("/api/v1/docs");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("pigy API");
  await expect(page.getByText("/api/v1/posts/{id}/move")).toBeVisible();
  expect(await overflowOf(page)).toBe(0);

  // Read as a script of somebody else's reads it, from outside the page:
  // the page has no script and asks for nothing, and its content security
  // policy refuses a request made from it.
  const document = await (await request.get("/api/v1/openapi.json")).json();
  expect(document).toMatchObject({ openapi: "3.1.0" });
  expect(Object.keys(document.paths)).toContain("/posts");
});
