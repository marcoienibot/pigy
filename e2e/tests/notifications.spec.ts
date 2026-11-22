import {
  armFault,
  connectSimulated,
  expectWorkspace,
  grace,
  notificationsRow,
  offerToInstall,
  openScreen,
  publishDraft,
  pushEndpointOf,
  receivedBy,
  sentPost,
  switchTo,
  withPushService,
} from "../app.ts";
import { expect, type Page, test } from "../fixtures.ts";
import { api, workspacesOf } from "../sandbox.ts";

// Push notifications, as far as a browser without a push service can show
// them. The Chromium of the tests has none: `pushManager.subscribe` fails
// there, nothing ever delivers a push message to it, and it refuses
// notifications to every site without asking anybody. So:
//
// - A page subscribes with `withPushService`, which hands it a device
//   that the simulated push service of the e2e build has made up, and
//   answers the browser's question in the person's place. From there on
//   everything is the built app: Settings, the routes, the Worker that
//   signs and encrypts, and the simulated push service that checks the
//   sender and decrypts as the device would.
// - What the service worker does with a message, and with a notification
//   that is pressed, is tested without a browser, in
//   apps/web/src/sw/push.test.ts. Here the two ends that a page has of it
//   are shown: the address that the worker opens, and what it tells a
//   window that is open.
//
// Not shown by any test, and to be seen on a deployed pigy and a real
// phone (PLAN.md section 19): that a real push service takes what pigy
// sends, that the service worker of the build shows it, on a lock screen
// too, and that pressing it brings the app to the front. The browser's
// debugging interface can hand a push message to a service worker, and
// was tried: the worker is then refused the notification, like every
// site in this browser.

/** The notices of the app, which the notice library lists. */
function notice(page: Page, text: string) {
  return page.getByRole("listitem").filter({ hasText: text });
}

test.describe("with a push service", () => {
  test.beforeEach(async ({ context }) => {
    await withPushService(context);
  });

  test("Settings turn the notifications of the device on and off, and say how they stand", async ({
    ownPage: page,
  }) => {
    await openScreen(page, "Settings");
    const row = notificationsRow(page);
    await expect(row).toContainText("Off.");

    await row.getByRole("button", { name: "Turn on" }).click();

    await expect(row).toContainText("On.");
    await expect(row.getByRole("button", { name: "Turn off" })).toBeVisible();
    // It is the server that says so, also after the page is loaded again.
    await page.reload();
    await expect(notificationsRow(page)).toContainText("On.");

    await notificationsRow(page)
      .getByRole("button", { name: "Turn off" })
      .click();

    await expect(notificationsRow(page)).toContainText("Off.");
    await page.reload();
    await expect(notificationsRow(page)).toContainText("Off.");
    // The browser has ended its subscription too.
    expect(await pushEndpointOf(page)).toBeNull();
  });

  test("Settings say that pigy cannot send to a browser whose push service it does not know, and leave the browser unsubscribed", async ({
    ownPage: page,
  }) => {
    // The browser subscribes at a push service of its own, which is not
    // in the list of the Worker: the device that the simulated push
    // service made up, at another address.
    await page.route("**/api/e2e/push/devices", async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        json: {
          ...(await response.json()),
          endpoint: "https://push.unknown-browser.example/device/1",
        },
      });
    });
    await openScreen(page, "Settings");
    const row = notificationsRow(page);
    await expect(row).toContainText("Off.");

    await row.getByRole("button", { name: "Turn on" }).click();

    // The Worker of the build refuses the address, and the row says what
    // that means for the person.
    await expect(row.getByRole("status")).toHaveText(
      "Notifications could not be turned on. pigy cannot send notifications to this browser yet. The inbox has what they would say.",
    );
    await expect(row).toContainText("Off.");
    await expect(row.getByRole("button", { name: "Turn on" })).toBeVisible();
    // The browser is not left subscribed at a push service that nothing
    // comes from.
    expect(await pushEndpointOf(page)).toBeNull();
  });

  test("the device is told when a post of the sandbox is not sent, as the sandbox's, and no more once it is turned off", async ({
    ownPage: page,
  }) => {
    await openScreen(page, "Settings");
    await notificationsRow(page)
      .getByRole("button", { name: "Turn on" })
      .click();
    await expect(notificationsRow(page)).toContainText("On.");
    const { sandbox } = await workspacesOf(page);
    await openScreen(page, "Channels");
    await connectSimulated(page, grace);
    await armFault(page, "Mastodon", "Access taken back");
    await openScreen(page, "Drafts");

    await publishDraft(page, "Locked out", grace);

    // Two things happened, and the device is told of each once: the post
    // was not sent, and the account has to be connected again. Neither
    // message has the text of the post or the name of the account.
    await expect.poll(async () => (await receivedBy(page)).length).toBe(2);
    const messages = (await receivedBy(page)) as Record<string, unknown>[];
    expect(messages).toContainEqual({
      v: 1,
      kind: "post_failed",
      workspaceId: sandbox,
      environment: "sandbox",
      postId: expect.any(String),
    });
    expect(messages).toContainEqual({
      v: 1,
      kind: "channel_needs_reconnect",
      workspaceId: sandbox,
      environment: "sandbox",
      channelId: expect.any(String),
      network: "mastodon",
    });
    expect(JSON.stringify(messages)).not.toContain("Locked out");
    expect(JSON.stringify(messages)).not.toContain("grace");

    // Turned off, the device hears nothing of the next one.
    const endpoint = await pushEndpointOf(page);
    await openScreen(page, "Settings");
    await notificationsRow(page)
      .getByRole("button", { name: "Turn off" })
      .click();
    await expect(notificationsRow(page)).toContainText("Off.");
    await openScreen(page, "Sent");
    await sentPost(page, "Locked out")
      .getByRole("link", { name: /^Reconnect/ })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Continue to Mastodon" }).click();
    await page.getByRole("button", { name: grace }).click();
    await armFault(page, "Mastodon", "Access taken back");
    await openScreen(page, "Drafts");
    await publishDraft(page, "Locked out again", grace);
    await openScreen(page, "Sent");
    await expect(sentPost(page, "Locked out again")).toContainText("Failed");
    const after = await api(page, "POST", "/api/e2e/push/received", {
      endpoint,
    });
    expect(after.body.messages).toHaveLength(2);
  });

  test("a device whose push service has dropped it is told nothing more, and Settings say that it is off", async ({
    ownPage: page,
  }) => {
    await openScreen(page, "Settings");
    await notificationsRow(page)
      .getByRole("button", { name: "Turn on" })
      .click();
    await expect(notificationsRow(page)).toContainText("On.");
    // The push service answers 410 from here on, as it does for a browser
    // that was uninstalled.
    await api(page, "POST", "/api/e2e/push/gone", {
      endpoint: await pushEndpointOf(page),
    });
    await openScreen(page, "Channels");
    await connectSimulated(page, grace);
    await armFault(page, "Mastodon", "Access taken back");
    await openScreen(page, "Drafts");
    await publishDraft(page, "Locked out", grace);
    await openScreen(page, "Sent");
    await expect(sentPost(page, "Locked out")).toContainText("Failed");

    // The Worker has tried, been told, and forgotten the device.
    await expect(async () => {
      await page.goto("/settings");
      await expect(notificationsRow(page)).toContainText("Off.", {
        timeout: 2000,
      });
    }).toPass();
  });
});

test("a notification that is pressed leads to its screen in its workspace, in a tab that showed the other one", async ({
  ownPage: page,
}) => {
  const { live, sandbox } = await workspacesOf(page);
  await expectWorkspace(page, "Sandbox");

  // What the service worker opens when no window of the app is open: an
  // address that names the workspace.
  await page.goto(`/sent?inWorkspace=${live}`);

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sent");
  await expectWorkspace(page, "Live");
  // The name is out of the address: the tab is not held to it.
  await expect(page).toHaveURL(/\/sent$/);
  await switchTo(page, "Sandbox");
  await expectWorkspace(page, "Sandbox");

  // What the service worker tells a window that is open: where to go. The
  // window goes there without being loaded again.
  await page.evaluate(() => {
    (window as { stayed?: boolean }).stayed = true;
  });
  const answer = await page.evaluate(
    (url) =>
      new Promise((resolve) => {
        // The worker sends a port along, and opens a window of its own
        // if nothing comes back on it.
        const { port1, port2 } = new MessageChannel();
        port1.onmessage = ({ data }) => resolve(data);
        navigator.serviceWorker.dispatchEvent(
          new MessageEvent("message", {
            data: { type: "navigate", url },
            ports: [port2],
          }),
        );
      }),
    `/inbox?inWorkspace=${live}`,
  );
  expect(answer).toEqual({ type: "navigated" });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Inbox");
  await expectWorkspace(page, "Live");
  expect(
    await page.evaluate(() => (window as { stayed?: boolean }).stayed),
  ).toBe(true);

  // A workspace that is not this person's counts as none named.
  await page.goto(`/sent?inWorkspace=${sandbox.replace(/.$/, "x")}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sent");
  await expectWorkspace(page, "Live");
  await expect(page).toHaveURL(/\/sent$/);
});

test("a message from the service worker leads to no address but one of the app", async ({
  ownPage: page,
}) => {
  const answers = await page.evaluate(async () => {
    /** Tells the page to go to `url`, and returns whether it said it does. */
    const tell = (url: string) =>
      new Promise<boolean>((resolve) => {
        const { port1, port2 } = new MessageChannel();
        port1.onmessage = () => resolve(true);
        navigator.serviceWorker.dispatchEvent(
          new MessageEvent("message", {
            data: { type: "navigate", url },
            ports: [port2],
          }),
        );
        // The page answers in the same turn in which it hears, or not.
        setTimeout(() => resolve(false), 200);
      });
    return [
      await tell("https://elsewhere.example/"),
      await tell("//elsewhere.example/"),
      await tell("/\\elsewhere.example/"),
      // An address of the app, last: the page still listens, and goes.
      await tell("/sent"),
    ];
  });

  // The page said of each whether it goes there, which is what this test
  // goes by: a page that had left for one of the first three would not
  // have answered the last, and the guard of the tests fails a test whose
  // page asks another host for anything.
  expect(answers).toEqual([false, false, false, true]);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sent");
});

test("Settings say that notifications are blocked where the person has refused them, and offer no button", async ({
  page,
  ownEmail,
  context,
}) => {
  await context.addInitScript(() =>
    Object.defineProperty(Notification, "permission", { value: "denied" }),
  );
  const { signIn } = await import("../fixtures.ts");
  await signIn(page, ownEmail);
  await page.goto("/settings");

  const row = notificationsRow(page);
  await expect(row).toContainText("Blocked in the settings of the browser.");
  await expect(row.getByRole("button")).toHaveCount(0);
});

test("Settings never ask the browser for its permission before somebody presses the button", async ({
  ownPage: page,
}) => {
  await page.addInitScript(() => {
    const counter = window as { asked?: number };
    // The browser of the tests refuses every site: here it has not been
    // asked yet, and the person closes its question without an answer.
    Object.defineProperty(Notification, "permission", { value: "default" });
    Notification.requestPermission = async () => {
      counter.asked = (counter.asked ?? 0) + 1;
      return "default";
    };
  });
  await page.reload();
  await openScreen(page, "Settings");
  const row = notificationsRow(page);
  await expect(row).toContainText("Off.");
  // The app is started and the screen is shown: nobody was asked.
  expect(
    await page.evaluate(() => (window as { asked?: number }).asked),
  ).toBeUndefined();

  await row.getByRole("button", { name: "Turn on" }).click();

  // The person has closed the question without an answer.
  await expect(row).toContainText(
    "The browser has not been given your permission, so nothing was turned on.",
  );
  await expect(row.getByRole("button", { name: "Turn on" })).toBeVisible();
  expect(await page.evaluate(() => (window as { asked?: number }).asked)).toBe(
    1,
  );
});

test.describe("on an iPhone", () => {
  test.use({
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  });

  test("Settings say that notifications take pigy on the Home Screen, where somebody would turn them on", async ({
    page,
    ownEmail,
    context,
  }) => {
    // Safari has no push messages for a page in a tab.
    await context.addInitScript(() => {
      delete (window as { PushManager?: unknown }).PushManager;
    });
    const { signIn } = await import("../fixtures.ts");
    await signIn(page, ownEmail);
    await page.goto("/settings");

    const row = notificationsRow(page);
    await expect(row).toContainText(
      "On an iPhone or iPad, notifications work once pigy is on the Home Screen.",
    );
    await expect(row).toContainText("Add to Home Screen");
    // Nothing to press: the browser could not do it.
    await expect(row.getByRole("button")).toHaveCount(0);
  });

  test("after the first post from a phone, pigy says once how to install it", async ({
    page,
    ownEmail,
    isMobile,
  }) => {
    test.skip(!isMobile, "The offer is for a phone");
    const { signIn } = await import("../fixtures.ts");
    await signIn(page, ownEmail);
    await openScreen(page, "Channels");
    await connectSimulated(page, grace);
    await openScreen(page, "Drafts");

    await publishDraft(page, "First post", grace);

    const offer = notice(page, "Install pigy on this phone");
    await expect(offer).toBeVisible();
    // Safari has nothing that a button could start: the notice leads to
    // where Settings explain it.
    await offer.getByRole("button", { name: "How" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Settings",
    );
    await expect(page.getByText("Add to Home Screen").first()).toBeVisible();
  });
});

test("after the first post from a phone, pigy offers once to install it, and never again", async ({
  ownPage: page,
  isMobile,
}) => {
  await openScreen(page, "Channels");
  await connectSimulated(page, grace);
  await openScreen(page, "Drafts");
  // The browser says that pigy can be installed.
  await offerToInstall(page);

  await publishDraft(page, "First post", grace);

  const offer = notice(page, "Install pigy on this phone");
  if (!isMobile) {
    // On a desktop nothing brings installing up: Settings and the command
    // palette have it. The notice of the post itself is there, so the
    // list of notices has been drawn.
    await expect(notice(page, "Publishing to")).toBeVisible();
    await expect(offer).toHaveCount(0);
    return;
  }
  await expect(offer).toBeVisible();
  await offer.getByRole("button", { name: "Install" }).click();
  expect(
    await page.evaluate(
      () => (window as { askedToInstall?: number }).askedToInstall,
    ),
  ).toBe(1);

  // The browser offers again, as after a prompt that was dismissed, and
  // the person publishes again: pigy does not bring it up a second time,
  // on this page or after a reload.
  await page.reload();
  await offerToInstall(page);
  await publishDraft(page, "Second post", grace);
  await expect(notice(page, "Publishing to")).toBeVisible();
  await expect(offer).toHaveCount(0);
});
