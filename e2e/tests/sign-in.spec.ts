import { adminEmail, expect, signIn, test, uniqueEmail } from "../fixtures.ts";

test("a signed-out visitor is sent to sign in and comes back to where they were heading", async ({
  page,
}) => {
  // Notes whether the app shell was ever on screen, however briefly. The
  // script runs again on every page load, so the note is read before the
  // sign-in leaves this page.
  await page.addInitScript(() => {
    const seen = window as { sawAppShell?: boolean };
    new MutationObserver(() => {
      if (document.querySelector('nav[aria-label="Main"]')) {
        seen.sawAppShell = true;
      }
    }).observe(document, { childList: true, subtree: true });
  });

  await page.goto("/settings/about");

  await expect(page).toHaveURL("/sign-in?returnTo=%2Fsettings%2Fabout");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Sign in to pigy",
  );
  // Nothing of the app was shown while the session was being checked.
  expect(
    await page.evaluate(
      () => (window as { sawAppShell?: boolean }).sawAppShell,
    ),
  ).toBeUndefined();

  await signIn(page, adminEmail);

  await expect(page).toHaveURL("/settings/about");
  // The screen itself, not only its address: the status comes from the API.
  await expect(page.getByRole("definition").first()).toHaveText("ok");
  // Now that the app shell is there, the note has to say so. Otherwise the
  // check above would pass without looking at anything.
  expect(
    await page.evaluate(
      () => (window as { sawAppShell?: boolean }).sawAppShell,
    ),
  ).toBe(true);
});

test("the consent page says that it is a simulation", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByRole("link", { name: "Sign in with Google" }).click();

  // Nobody must take this page for Google's.
  await expect(page).toHaveURL(/\/sim\/google\//);
  await expect(page.getByText("Simulation", { exact: true })).toBeVisible();
  await expect(page.getByText("This page stands in for Google")).toBeVisible();
});

test("somebody who is not invited sees the invite-only page", async ({
  page,
}, testInfo) => {
  await signIn(page, uniqueEmail(testInfo, "stranger"));

  await expect(page).toHaveURL("/invite-only");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "pigy is invite-only",
  );

  // And they are not signed in: the app sends them to the sign-in page.
  await page.goto("/");
  await expect(page).toHaveURL("/sign-in");
});

test("the sign-in page says why an unverified email address was refused", async ({
  page,
}) => {
  await signIn(page, adminEmail, { verified: false });

  await expect(page).toHaveURL("/sign-in?error=email_not_verified");
  await expect(page.getByRole("alert")).toContainText(
    "Google has not verified the email address",
  );
});

test("the user menu shows who is signed in and signs out", async ({
  signedInPage: page,
  isMobile,
}) => {
  const account = page.getByRole("button", { name: "Account" });
  // Both placements are in the DOM; only the one for this viewport shows.
  await expect(account.filter({ visible: true })).toHaveCount(1);
  const box = await account.filter({ visible: true }).boundingBox();
  const viewport = page.viewportSize();
  if (!box || !viewport) throw new Error("The user menu is not rendered");
  if (isMobile) {
    // In the header, at the top right, clear of the bottom bar.
    expect(box.y).toBeLessThan(60);
    expect(box.x).toBeGreaterThan(viewport.width / 2);
  } else {
    // At the bottom of the sidebar.
    expect(box.x).toBeLessThan(viewport.width / 4);
    expect(box.y).toBeGreaterThan(viewport.height / 2);
  }

  await account.filter({ visible: true }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toContainText(adminEmail);
  // The menu must fit on the screen, on a phone too.
  const menuBox = await menu.boundingBox();
  if (!menuBox) throw new Error("The menu is not rendered");
  expect(menuBox.x).toBeGreaterThanOrEqual(0);
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(viewport.width);

  await menu.getByRole("menuitem", { name: "Sign out" }).click();

  await expect(page).toHaveURL("/sign-in");
  // The session is gone, not just the screen: the app asks to sign in again.
  await page.goto("/queue");
  await expect(page).toHaveURL("/sign-in?returnTo=%2Fqueue");
});
