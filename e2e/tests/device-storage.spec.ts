import { openScreen, writeDraft } from "../app.ts";
import { expect, type Page, signIn, test } from "../fixtures.ts";

// What pigy asks of the browser about keeping what it stores on a device,
// and what Settings say of the answer.

/**
 * Puts a browser in the place of the one of `page` for the promise to
 * keep what a site stores: one that has not promised, and that answers a
 * request with `grants`. The browser of the tests decides by itself, by
 * how much a site has been used, which a test cannot go by. It holds for
 * the page loads from here on, each of which starts without a promise.
 */
async function browserThat(page: Page, { grants }: { grants: boolean }) {
  await page.addInitScript((grants) => {
    const state = { promised: false, grants, asked: 0 };
    StorageManager.prototype.persisted = async () => state.promised;
    StorageManager.prototype.persist = async () => {
      state.asked += 1;
      state.promised = state.grants;
      return state.promised;
    };
    Object.assign(window, { storagePromise: state });
  }, grants);
  type StoragePromise = { asked: number; grants: boolean };
  const state = (page: Page) =>
    page.evaluate(
      () =>
        (window as unknown as { storagePromise: StoragePromise })
          .storagePromise,
    );
  return {
    /** How often this page load has asked the browser to keep the data. */
    asked: async () => (await state(page)).asked,
    /** Makes the browser grant what it is asked from now on. */
    relent: () =>
      page.evaluate(() => {
        (
          window as unknown as { storagePromise: StoragePromise }
        ).storagePromise.grants = true;
      }),
  };
}

const promised = "The browser has promised to keep what pigy stores here";
const mayDelete = "The browser may delete what pigy stores here";

test("the browser is asked to keep the data with the first change, and Settings say that it has promised", async ({
  ownPage: page,
  isMobile,
}) => {
  const browser = await browserThat(page, { grants: true });
  await page.reload();

  // The app has started, and Settings have read what the browser says.
  // Neither has asked it for anything: a browser that asks the person
  // would do so before they have done anything worth keeping.
  await openScreen(page, "Settings");
  await expect(page.getByRole("main")).toContainText(mayDelete);
  expect(await browser.asked()).toBe(0);

  // A draft is two changes, and more with every key. The browser is asked
  // once.
  await openScreen(page, "Drafts");
  await writeDraft(page, isMobile, "Worth keeping");
  await expect.poll(browser.asked).toBe(1);

  await openScreen(page, "Settings");
  await expect(page.getByRole("main")).toContainText(promised);
  // Nothing is left to ask for.
  await expect(
    page.getByRole("button", { name: "Ask to keep it" }),
  ).toHaveCount(0);
  expect(await browser.asked()).toBe(1);
});

test("Settings say that the browser may delete the data, and ask it again when the person says so", async ({
  page,
  ownEmail,
  isMobile,
}) => {
  const browser = await browserThat(page, { grants: false });

  // Nobody is signed in: there is nothing of anybody to keep, and a
  // browser that asks the person would ask somebody who may not be let in.
  await page.goto("/sign-in");
  await expect(
    page.getByRole("link", { name: "Sign in with Google" }),
  ).toBeVisible();
  expect(await browser.asked()).toBe(0);

  await signIn(page, ownEmail);
  await writeDraft(page, isMobile, "Not promised to be kept");
  await expect.poll(browser.asked).toBe(1);

  // The browser has said no, and Settings say what that means.
  await openScreen(page, "Settings");
  await expect(page.getByRole("main")).toContainText(mayDelete);
  await expect(page.getByRole("main")).toContainText(
    "Changes that are not synced yet would be lost",
  );

  // A browser that decides by itself may decide otherwise later, as
  // Chrome does once the app is installed. The person asks again.
  await browser.relent();
  await page.getByRole("button", { name: "Ask to keep it" }).click();
  await expect(page.getByRole("main")).toContainText(promised);
  expect(await browser.asked()).toBe(2);
});
