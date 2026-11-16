import {
  connectSimulated,
  deliveryTo,
  expectWorkspace,
  feedOf,
  grace,
  openScreen,
  publishDraft,
  sentPost,
  switchTo,
} from "../app.ts";
import { expect, type Page, signIn, test } from "../fixtures.ts";

// The simulator: what the simulated networks of a sandbox have published,
// and the panel that makes them fail. It is the sandbox's alone, and the
// live workspace has it nowhere. The tests that publish through it are in
// publishing.spec.ts.

/** The heading of the screen that the page shows. */
function heading(page: Page) {
  return page.getByRole("heading", { level: 1 });
}

/** The navigation of the app, on a desktop or on a phone. */
function mainNavigation(page: Page) {
  return page.getByRole("navigation", { name: "Main" });
}

test("the simulator is the sandbox's: live has it nowhere, not even at its address", async ({
  ownPage: page,
}) => {
  const palette = page.getByRole("dialog", { name: "Commands" });
  // In the sandbox, the palette has it.
  await page.keyboard.press("ControlOrMeta+k");
  await palette.getByRole("combobox").fill("next publish fail");
  await page.keyboard.press("Enter");
  await expect(heading(page)).toHaveText("Simulator");
  await expect(
    page.getByRole("form", { name: "Make the next request fail" }),
  ).toBeVisible();

  // Every request that the page makes to the routes of the sandbox from
  // here on: in live there must be none.
  const asked: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/sandbox")) {
      asked.push(request.url());
    }
  });
  await switchTo(page, "Live");
  // The same address, with nothing at it.
  await expect(heading(page)).toHaveText("Not found");
  await expect(page.getByText("Not in the live workspace")).toBeVisible();
  await expect(
    mainNavigation(page).getByRole("link", { name: "Simulator" }),
  ).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+k");
  await palette.getByRole("combobox").fill("simul");
  await expect(palette.getByText("Nothing found.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  // And typed by hand.
  await page.goto("/simulator");
  await expectWorkspace(page, "Live");
  await expect(heading(page)).toHaveText("Not found");
  expect(asked).toEqual([]);

  // The way to where the person may have meant to be.
  await page.getByRole("button", { name: "Switch to the sandbox" }).click();
  await expectWorkspace(page, "Sandbox");
  await expect(heading(page)).toHaveText("Simulator");
  await expect(feedOf(page, grace)).toContainText("Nothing posted yet.");
});

test("nothing of the sandbox is shown under the name of live on the new screens, not even between two renders", async ({
  page,
  ownEmail,
}) => {
  // Watches every change of the page: whether a post of the sandbox, or a
  // feed of its world, is on screen without the banner of the sandbox.
  await page.addInitScript(() => {
    const seen = window as {
      listed?: { sandbox: boolean; mixed: boolean };
    };
    seen.listed = { sandbox: false, mixed: false };
    new MutationObserver(() => {
      const { listed } = seen;
      if (!listed) return;
      const inSandbox = document.querySelector('[role="note"]') !== null;
      const shown = [
        ...document.querySelectorAll(
          'ol[aria-label="Sent posts"] article, section[aria-label$="@grace@mastodon.example"]',
        ),
      ].some((item) => item.textContent?.includes("Sandbox post"));
      if (shown) {
        listed.sandbox = true;
        if (!inSandbox) listed.mixed = true;
      }
    }).observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
  const listed = () =>
    page.evaluate(
      () =>
        (window as { listed?: { sandbox: boolean; mixed: boolean } }).listed,
    );
  await signIn(page, ownEmail);
  await openScreen(page, "Channels");
  await connectSimulated(page, grace);
  await openScreen(page, "Drafts");
  await publishDraft(page, "Sandbox post", grace);
  await openScreen(page, "Sent");
  await expect(deliveryTo(sentPost(page, "Sandbox post"), grace)).toContainText(
    "Sent",
  );

  // Live has published nothing.
  await switchTo(page, "Live");
  await expect(page.getByText("Nothing sent yet")).toBeVisible();
  await switchTo(page, "Sandbox");
  await expect(sentPost(page, "Sandbox post")).toBeVisible();

  // The feeds are the sandbox's, and go with it.
  await openScreen(page, "Simulator");
  await expect(feedOf(page, grace)).toContainText("Sandbox post");
  await switchTo(page, "Live");
  await expect(heading(page)).toHaveText("Not found");

  // The observer saw the post, so it was watching: and never under live.
  expect(await listed()).toEqual({ sandbox: true, mixed: false });
});
