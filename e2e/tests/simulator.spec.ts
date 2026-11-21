import {
  armFault,
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
import { api } from "../sandbox.ts";

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

test("the simulator is the sandbox's: the switch to live leaves it, and live has it nowhere, not even at its address", async ({
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
  // Live has no such screen, and the person asked for live, not to be
  // told so: the switch leaves for the drafts.
  await expect(heading(page)).toHaveText("Drafts");
  await expect(page).toHaveURL("/");
  await expect(
    mainNavigation(page).getByRole("link", { name: "Simulator" }),
  ).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+k");
  await palette.getByRole("combobox").fill("simul");
  await expect(palette.getByText("Nothing found.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  // The address, typed by hand, has nothing at it and says so.
  await page.goto("/simulator");
  await expectWorkspace(page, "Live");
  await expect(heading(page)).toHaveText("Not found");
  await expect(page.getByText("Not in the live workspace")).toBeVisible();
  // A screen of the simulator would have asked for the world when it was
  // shown. A request that the test makes now is later than that one would
  // have been, so once it is in the list, the other would be too.
  await api(page, "GET", "/api/sandbox/feed?asked-by-the-test");
  expect(asked.map((url) => new URL(url).search)).toEqual([
    "?asked-by-the-test",
  ]);

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
  await expect(heading(page)).toHaveText("Drafts");

  // The observer saw the post, so it was watching: and never under live.
  expect(await listed()).toEqual({ sandbox: true, mixed: false });
});

/** Opens the failure panel of the simulator. */
async function openFailures(page: Page) {
  await openScreen(page, "Simulator");
  await page
    .getByRole("navigation", { name: "Simulator" })
    .getByRole("link", { name: "Failures" })
    .click();
}

/** The path of the route that lists and changes the faults of a sandbox. */
const faultsRoute = "**/api/sandbox/faults";

test("the failure panel changes one thing at a time: nothing can be armed while the faults are being disarmed", async ({
  ownPage: page,
}) => {
  await armFault(page, "Mastodon", "Server error");
  const armed = page.getByRole("list", { name: "Armed faults" });
  const arm = page.getByRole("button", { name: "Arm", exact: true });
  const disarm = page.getByRole("button", { name: "Disarm all" });

  // The answer to "Disarm all" is held back, so that the moment lasts in
  // which a second change could be started. Its answer would arrive first
  // and be replaced by this one, which says that nothing is armed.
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached = () => {};
  const asked = new Promise<void>((resolve) => {
    reached = resolve;
  });
  await page.route(faultsRoute, async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    const response = await route.fetch();
    reached();
    await released;
    await route.fulfill({ response });
  });
  await disarm.click();
  await asked;
  await expect(arm).toBeDisabled();
  await expect(disarm).toBeDisabled();
  // What was armed is listed until the server has answered.
  await expect(armed).toContainText("Server error");

  release();
  await expect(page.getByText("Nothing is armed")).toBeVisible();
  await expect(armed).toHaveCount(0);
  await expect(arm).toBeEnabled();
  // Nothing is left to disarm, for the server too: the page asks it anew.
  await page.reload();
  await expect(page.getByText("Nothing is armed")).toBeVisible();
});

test("the failure panel takes a fault off its list when a post from another window has used it up", async ({
  ownPage: page,
  context,
}) => {
  await openScreen(page, "Channels");
  await connectSimulated(page, grace);
  await armFault(page, "Mastodon", "Access taken back");
  const armed = page.getByRole("list", { name: "Armed faults" });
  await expect(armed).toContainText("Access taken back");

  // Another tab of the same sandbox publishes, and the fault strikes.
  const other = await context.newPage();
  await other.goto("/");
  await publishDraft(other, "Struck from elsewhere", grace);
  await openScreen(other, "Sent");
  await expect(
    deliveryTo(sentPost(other, "Struck from elsewhere"), grace),
  ).toContainText("Failed");

  // The panel was not touched, and says what is true.
  await expect(page.getByText("Nothing is armed")).toBeVisible();
  await expect(armed).toHaveCount(0);
});

/** How many faults the server has armed in the sandbox of `page`. */
async function armedAtServer(page: Page): Promise<number> {
  const { body } = await api(page, "GET", "/api/sandbox/faults");
  return (body as { networks: { armed: unknown[] }[] }).networks.flatMap(
    ({ armed }) => armed,
  ).length;
}

test("the failure panel takes a fault off its list while the delivery that it struck waits to be tried again", async ({
  ownPage: page,
  context,
}) => {
  await openScreen(page, "Channels");
  await connectSimulated(page, grace);
  // A fault that the network asks to have tried again: the workflow waits
  // a minute after it, and nothing of the workspace changes meanwhile.
  await armFault(page, "Mastodon", "Server error");
  const armed = page.getByRole("list", { name: "Armed faults" });

  // The panel also reads its list when the delivery begins, which can be
  // before the fault strikes or after it. The test makes it before: until
  // it has seen that the fault is used up, the panel is answered with the
  // list as it is now. What the panel shows after that, it has asked for
  // without a change of the workspace to tell it to.
  const { body: before } = await api(page, "GET", "/api/sandbox/faults");
  let struck = false;
  await page.route(faultsRoute, (route) =>
    struck || route.request().method() !== "GET"
      ? route.fallback()
      : route.fulfill({ json: before }),
  );

  const other = await context.newPage();
  await other.goto("/");
  await publishDraft(other, "Kept waiting", grace);
  await openScreen(other, "Sent");
  const delivery = deliveryTo(sentPost(other, "Kept waiting"), grace);
  await expect(delivery).toContainText("Sending");
  // Asked from the other tab, whose requests the route does not answer.
  await expect.poll(() => armedAtServer(other)).toBe(0);
  await expect(armed).toContainText("Server error");
  struck = true;

  await expect(page.getByText("Nothing is armed")).toBeVisible({
    timeout: 15_000,
  });
  await expect(armed).toHaveCount(0);
  // The delivery has not moved on since: the wait is a minute, which is
  // longer than this test may take.
  await expect(delivery).toContainText("Sending");
});

test("the failure panel does not bring a fault back that was used up while the answer to arming it was on its way", async ({
  ownPage: page,
  context,
}) => {
  await openScreen(page, "Channels");
  await connectSimulated(page, grace);
  await openFailures(page);
  const form = page.getByRole("form", { name: "Make the next request fail" });
  await page.getByRole("radio", { name: "Mastodon" }).check();
  await page.getByRole("radio", { name: "Access taken back" }).check();

  // The server arms the fault, and its answer is held back.
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached = () => {};
  const armedAt = new Promise<void>((resolve) => {
    reached = resolve;
  });
  await page.route(faultsRoute, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const response = await route.fetch();
    reached();
    await released;
    await route.fulfill({ response });
  });
  await form.getByRole("button", { name: "Arm", exact: true }).click();
  await armedAt;

  // Another tab publishes meanwhile, and the fault strikes. The panel
  // hears that the delivery has moved on, which is when it reads its list.
  const other = await context.newPage();
  await other.goto("/");
  await publishDraft(other, "Struck meanwhile", grace);
  await openScreen(other, "Sent");
  await expect(
    deliveryTo(sentPost(other, "Struck meanwhile"), grace),
  ).toContainText("Failed");
  expect(await armedAtServer(other)).toBe(0);

  // The answer arrives now, and says that the fault is armed, which was
  // true when it was made. The form says that the answer is there: before
  // that, nothing was listed either.
  release();
  await expect(form.getByRole("status")).toContainText("Armed: ");
  await expect(page.getByText("Nothing is armed")).toBeVisible();
  await expect(page.getByRole("list", { name: "Armed faults" })).toHaveCount(0);
});

test("the failure panel says so when its list could not be read again, and reads it when asked to", async ({
  ownPage: page,
}) => {
  await armFault(page, "Mastodon", "Server error");
  const armed = page.getByRole("list", { name: "Armed faults" });

  // The server cannot be reached for the list.
  let down = true;
  await page.route(faultsRoute, (route) =>
    down && route.request().method() === "GET"
      ? route.abort()
      : route.fallback(),
  );
  // The panel reads its list again when the browser says that the
  // connection is back: that is the read that fails here.
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  const alert = page
    .getByRole("alert")
    .filter({ hasText: "could not be refreshed" });
  await expect(alert).toContainText(
    "The list of armed faults could not be refreshed: pigy cannot reach its server. Check your connection and try again. What is shown is from before.",
  );
  await expect(armed).toContainText("Server error");

  // The list changes meanwhile, so that the next read shows that it was
  // made: disarming is not a read, and passes.
  await api(page, "DELETE", "/api/sandbox/faults");
  await expect(armed).toContainText("Server error");
  down = false;
  await alert.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Nothing is armed")).toBeVisible();
  await expect(alert).toHaveCount(0);
});

test("the failure panel says what the server answered when it refuses a fault, and arms nothing", async ({
  ownPage: page,
}) => {
  await openFailures(page);
  const form = page.getByRole("form", { name: "Make the next request fail" });
  // The panel offers only what the server has declared, so the server of
  // the test never refuses it: the test answers in its place, as the route
  // does for a fault that the network does not have. Only the first time
  // that a fault is armed: the panel also reads its list by this route,
  // and those requests pass.
  let refused = false;
  await page.route(faultsRoute, (route) => {
    if (refused || route.request().method() !== "POST") return route.fallback();
    refused = true;
    return route.fulfill({
      status: 400,
      json: {
        error: "InvalidInputError",
        message: "Mastodon has no such fault.",
        field: "kind",
      },
    });
  });
  const arm = form.getByRole("button", { name: "Arm", exact: true });
  await arm.click();
  await expect(form.getByRole("alert")).toHaveText(
    "Mastodon has no such fault.",
  );
  await expect(page.getByText("Nothing is armed")).toBeVisible();

  // The form can be used again, and what it says then is about that.
  await arm.click();
  await expect(form.getByRole("alert")).toHaveCount(0);
  await expect(form.getByRole("status")).toContainText("Armed: ");
  await expect(page.getByRole("list", { name: "Armed faults" })).toHaveCount(1);
});

test("R asks for the feeds again", async ({ ownPage: page }) => {
  await openScreen(page, "Simulator");
  await expect(feedOf(page, grace)).toContainText("Nothing posted yet.");
  // Nothing has changed that the page would ask again for by itself, so
  // the request that follows the key is the key's.
  const asked = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/api/sandbox/feed",
  );
  await page.keyboard.press("r");
  await asked;
  await expect(feedOf(page, grace)).toContainText("Nothing posted yet.");
});
