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
 * the browser, which is signed in already. With `newerHeld`, the newer
 * version cannot be installed before the function that this returns is
 * called.
 */
async function openOlderVersion(
  page: Page,
  { newerHeld = false } = {},
): Promise<() => void> {
  const versions = await olderVersionFirst(page.context());
  const release = newerHeld ? versions.holdNewer() : () => {};
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Drafts");
  await serviceWorkerAnswersFor(page);
  return release;
}

/**
 * Marks the window of `page`. The mark is gone when the page is loaded
 * again, and says before that whether the page has begun to leave: the
 * browser tells a page so in the moment in which a script asks for a
 * reload, which is earlier than the test would see the new page.
 */
async function mark(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window as { sameLoad?: boolean; leaving?: boolean };
    state.sameLoad = true;
    window.addEventListener("beforeunload", () => {
      state.leaving = true;
    });
  });
}

/** What is left of the mark of `mark` in the window of `page`. */
function markOf(page: Page): Promise<{ sameLoad: boolean; leaving: boolean }> {
  return page.evaluate(() => {
    const state = window as { sameLoad?: boolean; leaving?: boolean };
    return {
      sameLoad: state.sameLoad === true,
      leaving: state.leaving === true,
    };
  });
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
  await mark(page);

  await comeBackTo(page);

  // The new version is fetched and installed behind the page, which is
  // told when that is done: Settings offer it. Nothing has happened to
  // the page: it is the one that was loaded before.
  const nav = page.getByRole("navigation", { name: "Main" });
  await backToList(page, isMobile);
  await nav.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByText("A new version of pigy is ready")).toBeVisible();
  expect(await markOf(page)).toEqual({ sameLoad: true, leaving: false });
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

  // The first window does not stay behind as the older version under
  // the service worker of the newer one: after a real release the files
  // of the older one would be gone. It has loaded itself again, where it
  // was, and nothing that was written in it is lost.
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
  // The window asks for the newer version as soon as it knows that it is
  // too old, before anybody can press a button. Left alone, the newer
  // version would be installed and waiting by the time of the click, and
  // a reload that asked nobody would start as it too. So its install is
  // held: until the test says, the device has the older version only.
  const installNewer = await openOlderVersion(page, { newerHeld: true });
  await expectSync(page, "Reload to update");
  await mark(page);

  await page
    .getByRole("button", { name: "Sync: Reload to update" })
    .filter({ visible: true })
    .first()
    .click();
  const reload = page
    .getByRole("dialog")
    .getByRole("button", { name: "Reload" });
  await reload.click();

  // The button has the window wait for the newer version: it is the page
  // that was clicked in, and has not begun to load itself again. A reload
  // that asked nobody would have begun in the click, and would bring the
  // older version back, from the device.
  await expect(reload).toBeDisabled();
  expect(await markOf(page)).toEqual({ sameLoad: true, leaving: false });

  installNewer();

  // Now there is a newer version to start as, and the reload that waited
  // for it does.
  await expect(newerVersion(page)).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Drafts");
});
