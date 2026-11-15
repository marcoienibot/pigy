import {
  backToList,
  draftRow,
  editor,
  expectSync,
  newerVersion,
  olderVersionFirst,
  serviceWorkerAnswersFor,
  writeDraft,
} from "../app.ts";
import { expect, type Page, test } from "../fixtures.ts";

// How a new version of the app takes the place of the one before it:
// apps/web/src/lib/service-worker.ts has the rules. `olderVersionFirst`
// says where the two versions of these tests come from, and why a test
// loads no page before it wants the newer one to be found.

/**
 * Opens the app in `page` as its older version: the first page load of
 * the browser, which is signed in as `email` already.
 */
async function openOlderVersion(page: Page): Promise<void> {
  await olderVersionFirst(page.context());
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Drafts");
  await serviceWorkerAnswersFor(page);
}

/**
 * Has `page` look for a new version, as the app does when its window comes
 * back to the front. The window of a test is always at the front, so the
 * browser is only made to say so again.
 */
async function comeBackTo(page: Page): Promise<void> {
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
}

test("a new version waits while the app is in use, and takes over when the app is opened again", async ({
  page,
  context,
  ownEmail,
  signInBeforeFirstLoad,
  isMobile,
}) => {
  await signInBeforeFirstLoad(ownEmail);
  await openOlderVersion(page);
  await writeDraft(page, isMobile, "Begun under the older version");
  await draftRow(page, "Begun under the older version").click();
  await editor(page).press("End");
  await page.keyboard.type(", and");
  await expectSync(page, "Synced");
  // Gone with the next page load, if there is one.
  await page.evaluate(() => {
    (window as { sameLoad?: boolean }).sameLoad = true;
  });

  await comeBackTo(page);

  // The new version is fetched and installed behind the page, which is
  // told when that is done: Settings offer it. Nothing has happened to
  // the page: it is the one that was loaded before.
  const nav = page.getByRole("navigation", { name: "Main" });
  await backToList(page, isMobile);
  await nav.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByText("A new version of pigy is ready")).toBeVisible();
  expect(
    await page.evaluate(() => (window as { sameLoad?: boolean }).sameLoad),
  ).toBe(true);
  // And the person goes on writing.
  await nav.getByRole("link", { name: "Drafts" }).click();
  await draftRow(page, "Begun under the older version").click();
  await editor(page).press("End");
  await page.keyboard.type(" finished under it");
  await expect(editor(page)).toHaveValue(
    "Begun under the older version, and finished under it",
  );
  await expectSync(page, "Synced");

  // The app is opened again, in a second window. That is the moment: the
  // new version takes over before the window shows anything, so what it
  // shows is the new version.
  const second = await context.newPage();
  await second.goto("/");
  await expect(second.getByRole("heading", { level: 1 })).toHaveText("Drafts");
  await expect(newerVersion(second)).toHaveCount(1);

  // The first window cannot stay behind as the older version: the files
  // of that one are gone. It has loaded itself again, where it was, and
  // nothing that was written in it is lost.
  await expect(newerVersion(page)).toHaveCount(1);
  await expect(editor(page)).toHaveValue(
    "Begun under the older version, and finished under it",
  );
  // Nothing is left to offer.
  await second
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Settings" })
    .click();
  await expect(
    second.getByRole("heading", { name: "Appearance" }),
  ).toBeVisible();
  await expect(second.getByText("A new version of pigy is ready")).toHaveCount(
    0,
  );
});

test("the new version is loaded at once for somebody who asks in Settings", async ({
  page,
  ownEmail,
  signInBeforeFirstLoad,
}) => {
  await signInBeforeFirstLoad(ownEmail);
  await openOlderVersion(page);
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Settings" })
    .click();
  const reload = page.getByRole("button", { name: "Reload to update" });
  await expect(page.getByRole("heading", { name: "Appearance" })).toBeVisible();
  // Nothing to offer before the browser has looked.
  await expect(reload).toHaveCount(0);

  await comeBackTo(page);
  await reload.click();

  await expect(newerVersion(page)).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Appearance" })).toBeVisible();
  await expect(reload).toHaveCount(0);
});

test("a window that is too old for the server loads the new version when it is reloaded", async ({
  page,
  ownEmail,
  signInBeforeFirstLoad,
}) => {
  // The server speaks a later version of the protocol than this app, old
  // or new: the test answers the hello in its place, as in
  // sync-drafts.spec.ts.
  await page.routeWebSocket(/\/sync\//, (socket) => {
    socket.onMessage(() => {
      socket.send(
        JSON.stringify({
          type: "error",
          code: "version_mismatch",
          message: "The client and the server speak different versions",
          protocolVersion: 1000,
          schemaVersion: 1,
        }),
      );
      void socket.close({ code: 4400, reason: "version_mismatch" });
    });
  });
  await signInBeforeFirstLoad(ownEmail);
  await openOlderVersion(page);
  await expectSync(page, "Reload to update");

  await page
    .getByRole("button", { name: "Sync: Reload to update" })
    .filter({ visible: true })
    .first()
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Reload" })
    .click();

  // A reload alone would bring the older version back, from the device:
  // nothing but the reload of this window has looked for a newer one.
  await expect(newerVersion(page)).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Drafts");
});
