import {
  backToList,
  breakStorage,
  channelRows,
  connectionOf,
  connectSimulated,
  draftRow,
  editor,
  expectElsewhere,
  expectSync,
  expectWorkspace,
  grace,
  openConsentPage,
  openScreen,
  sandboxServer,
  switchTo,
  writeDraft,
} from "../app.ts";
import { expect, type Page, type Route, signIn, test } from "../fixtures.ts";

// The Channels screen: the accounts of a workspace, connecting one through
// the consent page of its network and disconnecting it. Every sandbox has
// the same simulated accounts and the tests run at the same time, so each
// test is somebody of its own, in a sandbox of their own: `ownPage`.
//
// The Worker tests cover what the routes do. These are about what a person
// sees, and about what only a browser shows: that the way from the app to
// the simulated network and back holds together with the cookie and the
// Origin that a browser sends, and leads to no other host, which the
// fixture would fail the test for.

/** What the screen says above the list about what has just happened. */
function notice(page: Page) {
  return page.getByRole("main").getByRole("status");
}

/** The same, for what did not work. */
function alert(page: Page) {
  return page.getByRole("main").getByRole("alert");
}

/**
 * Holds back the answer to a disconnect of `page` from now on, until the
 * function that this returns is called, and has it say then that the
 * network did not take the access back: what the simulated server never
 * says. The request itself goes through at once, so the channel is gone
 * from the server while the page still waits.
 */
async function holdDisconnect(page: Page): Promise<() => void> {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/workspaces/*/channels/*", async (route) => {
    const response = await route.fetch();
    await released;
    await route.fulfill({ response, json: { revoked: false } });
  });
  return release;
}

/**
 * The notice that a disconnect of `grace` leaves on whichever screen the
 * person is on when the network did not take the access back.
 */
function warningElsewhere(page: Page) {
  return page.getByRole("listitem").filter({
    hasText: `${grace} is disconnected, but pigy could not give its access back to Mastodon`,
  });
}

/** How far the page is wider than its window, which it must not be. */
function overflow(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
}

test("somebody new is led from the empty drafts screen to a connected simulated account", async ({
  ownPage: page,
}) => {
  // The first screen says where they are and what to do first.
  await expect(page.getByRole("main")).toContainText("This is your sandbox");
  await page.getByRole("link", { name: "Connect a simulated account" }).click();

  // The form of the first network that can be connected, with nothing to
  // guess: the sandbox has one server, which is filled in and named as
  // what it is.
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Connect a Mastodon account");
  await expect(dialog).toContainText("its Mastodon is simulated");
  await expect(dialog.getByLabel("Server")).toHaveValue(sandboxServer);
  await expect(dialog.getByLabel("Server")).toHaveAccessibleDescription(
    `${sandboxServer} is the simulated server of the sandbox, and the only one it has.`,
  );
  // The keyboard is in the field, so Enter goes on.
  await expect(dialog.getByLabel("Server")).toBeFocused();
  await page.keyboard.press("Enter");

  // A page of the app itself, which says what it is.
  await page.waitForURL(
    ({ pathname }) =>
      pathname === `/sim/network/${sandboxServer}/oauth/authorize`,
  );
  await expect(page.getByText("Simulation", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "pigy wants to use your account" }),
  ).toBeVisible();
  // It has to fit the screen, on a phone too.
  expect(await overflow(page)).toBe(0);
  await page.getByRole("button", { name: grace }).click();

  // Back on the Channels screen of the sandbox, which says what happened
  // and lists the account.
  await expect(notice(page)).toHaveText(
    `Grace Hopper (${grace}) is connected.`,
  );
  await expectWorkspace(page, "Sandbox");
  await expect(channelRows(page)).toHaveCount(1);
  await expect(channelRows(page)).toContainText("Grace Hopper");
  await expect(channelRows(page)).toContainText(`Mastodon · ${grace}`);
  await expect(channelRows(page)).toContainText("Connected");
  expect(await overflow(page)).toBe(0);
  // The address no longer says how the connection ended, so loading the
  // page again does not say it again. The list is waited for first: the
  // notice would not be there before it either.
  await expect(page).toHaveURL("/channels");
  await page.reload();
  await expect(channelRows(page)).toHaveCount(1);
  await expect(notice(page)).toHaveCount(0);

  // With an account connected, the drafts screen no longer sends people
  // here.
  await openScreen(page, "Drafts");
  await expect(
    page.getByRole("heading", { name: "No drafts yet" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Connect a simulated account" }),
  ).toHaveCount(0);
});

test("the empty Channels screen says what a channel is, and the choice of a network lists what is coming", async ({
  ownPage: page,
}) => {
  await openScreen(page, "Channels");

  const main = page.getByRole("main");
  await expect(main).toContainText(
    "A channel is an account on a network that pigy posts to for you",
  );
  await expect(main).toContainText("LinkedIn and Threads are coming");
  // One click to the form from here.
  await main
    .getByRole("button", { name: "Connect a simulated Mastodon account" })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Server")).toHaveValue(sandboxServer);

  // Back to the choice of a network. What cannot be connected yet is
  // listed, and is nothing to press.
  await dialog.getByRole("button", { name: "Networks" }).click();
  const networks = dialog.getByRole("list", { name: "Networks" });
  await expect(networks.getByRole("listitem")).toHaveText([
    "Mastodon",
    "Bluesky",
    "LinkedInComing soon",
    "ThreadsComing soon",
  ]);
  await expect(networks.getByRole("button")).toHaveText([
    "Mastodon",
    "Bluesky",
  ]);

  // Closing leaves the screen as it was, with the address of the screen.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL("/channels");
});

test("connects a simulated Bluesky account through the consent page of its server", async ({
  ownPage: page,
}) => {
  await openScreen(page, "Channels");
  await page
    .getByRole("main")
    .getByRole("button", { name: "Connect a simulated Bluesky account" })
    .click();

  // What a person types for Bluesky is a handle. The sandbox has filled
  // one of its simulated accounts in, and names them all.
  const dialog = page.getByRole("dialog");
  const handle = dialog.getByLabel("Handle");
  await expect(handle).toHaveValue("ada.bsky.test");
  await expect(handle).toHaveAccessibleDescription(
    "The sandbox has three simulated accounts: ada.bsky.test, grace.bsky.test and alan.bsky.test.",
  );

  // A real handle, which the world of the sandbox does not have, is
  // refused next to the field, with what to enter instead.
  await handle.fill("grace.bsky.social");
  await dialog.getByRole("button", { name: "Continue to Bluesky" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "The sandbox has no account grace.bsky.social. Enter the handle of one of its simulated accounts: ada.bsky.test, grace.bsky.test and alan.bsky.test.",
  );
  await expect(handle).toBeFocused();

  await handle.fill("@grace.bsky.test");
  await dialog.getByRole("button", { name: "Continue to Bluesky" }).click();

  // The consent page of the simulated entryway of Bluesky, which the app
  // serves. It offers the account whose handle was entered, and no other:
  // pigy would not take another one.
  await page.waitForURL(
    ({ pathname }) => pathname === "/sim/network/bsky.social/oauth/authorize",
  );
  await expect(page.getByText("Simulation", { exact: true })).toBeVisible();
  const accounts = page.locator('button[name="account"]');
  await expect(accounts).toHaveCount(1);
  expect(await overflow(page)).toBe(0);
  await accounts.getByText("@grace.bsky.test").click();

  await expect(notice(page)).toHaveText(
    "Grace Hopper (@grace.bsky.test) is connected.",
  );
  await expect(channelRows(page)).toHaveCount(1);
  await expect(channelRows(page)).toContainText("Bluesky · @grace.bsky.test");
  await expect(channelRows(page)).toContainText("Connected");
});

test("the dialog that connects an account is one step back in the browser, and closing it leaves the history as it was", async ({
  ownPage: page,
}) => {
  await openScreen(page, "Channels");
  const dialog = page.getByRole("dialog");
  const connect = page.getByRole("button", { name: "Connect account" });
  const heading = page.getByRole("heading", { level: 1 });

  // Two steps into the dialog, and one step back is out of it: not at
  // the choice of a network that the form came from.
  await connect.click();
  await dialog.getByRole("button", { name: "Mastodon" }).click();
  await expect(dialog.getByLabel("Server")).toBeVisible();
  await page.goBack();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL("/channels");

  // Through the steps again, and out with "Cancel". One Back then leaves
  // the screen, as it did before the dialog was opened. A dialog that put
  // the screen in the place of its entry when it closed would leave the
  // screen in the history twice: this Back would change nothing, and the
  // heading would go on saying "Channels".
  await connect.click();
  await dialog.getByRole("button", { name: "Mastodon" }).click();
  await dialog.getByRole("button", { name: "Networks" }).click();
  await dialog.getByRole("button", { name: "Mastodon" }).click();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL("/channels");
  await page.goBack();
  await expect(heading).toHaveText("Drafts");

  // Three times in and out, each time another way out. It is still one
  // Back: an entry left behind by any of the three would be in its way.
  await openScreen(page, "Channels");
  await connect.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await connect.click();
  await dialog.getByRole("button", { name: "Mastodon" }).click();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await connect.click();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL("/channels");
  await page.goBack();
  await expect(heading).toHaveText("Drafts");

  // The entry of the dialog still says that the screen is under it when
  // the page has been loaded again with the dialog open. Closing it goes
  // back to the screen, and one Back leaves it. Kept in the memory of the
  // page, that would be forgotten here, and the dialog would close the
  // way it does on an address that was opened directly, which leaves an
  // entry of the screen for this Back to stop at.
  await openScreen(page, "Channels");
  await connect.click();
  await dialog.getByRole("button", { name: "Mastodon" }).click();
  await page.reload();
  await expect(dialog.getByLabel("Server")).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL("/channels");
  await page.goBack();
  await expect(heading).toHaveText("Drafts");
});

test("closing the dialog on an address that was opened directly leads back to where the person came from", async ({
  ownPage: page,
}) => {
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toHaveText("Drafts");
  // From the Drafts screen to the address of the dialog, as a bookmark or
  // a link in a message leads to it: no button of the Channels screen
  // opened it, and what is under its entry is not that screen.
  await page.goto("/channels?add=true");
  const dialog = page.getByRole("dialog", { name: "Connect an account" });
  await expect(dialog).toBeVisible();

  await page.keyboard.press("Escape");

  // The person is on the screen that the dialog was over. A dialog that
  // went back in the history here, as it does where the screen is under
  // it, would have taken them off the screen: to the Drafts screen.
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL("/channels");
  await expect(heading).toHaveText("Channels");
  // And Back leads to where they came from. A dialog that added an entry
  // when it closed would have this lead into the dialog again.
  await page.goBack();
  await expect(heading).toHaveText("Drafts");
  await expect(page).toHaveURL("/");
});

test("cancelling at the consent page is put in words, and connects nothing", async ({
  ownPage: page,
}) => {
  await openScreen(page, "Channels");
  await openConsentPage(page);

  await page.getByRole("button", { name: "Cancel" }).click();

  await expect(notice(page)).toHaveText(
    "You cancelled at Mastodon. Nothing was connected.",
  );
  await expect(page).toHaveURL("/channels");
  await expect(
    page.getByRole("heading", { name: "No accounts connected" }),
  ).toBeVisible();
  // The notice can be closed.
  await page.getByRole("main").getByRole("button", { name: "Close" }).click();
  await expect(notice(page)).toHaveCount(0);
});

test("an address that the sandbox does not have is refused next to the field", async ({
  ownPage: page,
}) => {
  await openScreen(page, "Channels");
  await page.getByRole("button", { name: "Connect account" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Mastodon" }).click();
  const server = dialog.getByLabel("Server");

  // A real server, which a sandbox does not reach.
  await server.fill("mastodon.social");
  await dialog.getByRole("button", { name: "Continue to Mastodon" }).click();

  // The words of the route, with the field that they are about: marked,
  // described by them, and with the keyboard in it.
  const refusal = `The sandbox has no server mastodon.social. Enter ${sandboxServer}, its simulated server.`;
  await expect(dialog.getByRole("alert")).toHaveText(refusal);
  await expect(server).toHaveAttribute("aria-invalid", "true");
  await expect(server).toHaveAccessibleDescription(new RegExp(refusal));
  await expect(server).toBeFocused();
  await expect(page).toHaveURL(/\/channels\?add=mastodon$/);

  // Nothing at all is not sent anywhere.
  await server.fill("  ");
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("alert")).toHaveText(
    "Enter the server of the account.",
  );

  // With the server of the sandbox the way is clear, and the refusal gone.
  await server.fill(sandboxServer);
  await page.keyboard.press("Enter");
  await page.waitForURL(({ pathname }) => pathname.startsWith("/sim/network/"));
});

test("a server in trouble and a pigy without keys are said at the form, not at the field", async ({
  ownPage: page,
}) => {
  await openScreen(page, "Channels");
  // In live, where a server is asked for and nothing is filled in.
  await switchTo(page, "Live");
  await page.getByRole("button", { name: "Connect account" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Mastodon" }).click();
  const server = dialog.getByLabel("Server");
  await expect(server).toHaveValue("");
  await expect(dialog).toContainText("pigy never sees your password");

  // The Worker of this build reaches no real host: what a live workspace
  // asks of a network is answered with a 502, the answer for a server
  // that may be fine later. The host is under ".invalid", so the request
  // would reach nobody if that guard were lost.
  await server.fill("mastodon.example.invalid");
  await dialog.getByRole("button", { name: "Continue to Mastodon" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "mastodon.example.invalid is having trouble (HTTP 502). Try again in a moment.",
  );
  // Nothing is wrong with what was typed.
  await expect(server).not.toHaveAttribute("aria-invalid");

  // A pigy that was not given the keys to store credentials with answers
  // 503. This build has keys, so the test answers in its place, with the
  // words of the route.
  await page.route("**/api/workspaces/*/connect", (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: "UnexpectedError",
        message: "This pigy is not set up to connect accounts.",
      },
    }),
  );
  await dialog.getByRole("button", { name: "Continue to Mastodon" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "This pigy is not set up to connect accounts. Whoever runs it has to give it the key",
  );
  await expect(server).not.toHaveAttribute("aria-invalid");
});

test("a connection that is called off while it is being begun does not take the browser to the network", async ({
  ownPage: page,
}) => {
  await openScreen(page, "Channels");
  // In live, where the consent page is that of a real network.
  await switchTo(page, "Live");
  // The answer to the first request that begins a connection is held back
  // until the test gives it. The later ones pass.
  const held: Route[] = [];
  await page.route("**/api/workspaces/*/connect", (route) => {
    if (held.length === 0) held.push(route);
    else void route.fallback();
  });
  // Where the page goes for the consent of a network. The fixture stops a
  // request to another host and fails the test for it: this list is the
  // same check, where it can be read.
  const consentPage = "https://mastodon.example.invalid/oauth/authorize";
  const left: string[] = [];
  page.on("request", (request) => {
    if (request.url() === consentPage) left.push(request.url());
  });
  await page.getByRole("button", { name: "Connect account" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Mastodon" }).click();
  await dialog.getByLabel("Server").fill("mastodon.example.invalid");
  await dialog.getByRole("button", { name: "Continue to Mastodon" }).click();
  // The request is on its way, and the form says so.
  await expect(
    dialog.getByRole("button", { name: "Connecting…" }),
  ).toBeDisabled();
  await expect.poll(() => held).toHaveLength(1);

  // The person thinks better of it, and goes on to the sandbox.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await switchTo(page, "Sandbox");

  // Only now does the answer come, as a real network would have it: this
  // build reaches none, so the test gives it. The page has given the
  // request up, which is not for the test to rely on: an answer that it
  // still took must not lead anywhere either.
  await held[0]?.fulfill({ json: { url: consentPage } });
  // The page does not leave for the network. It would have by now if it
  // were going to: it has since begun another connection, in the sandbox,
  // and followed that answer, which came after the one it was given first.
  await connectSimulated(page, grace);
  expect(left).toEqual([]);
});

test("leaving for a network asks first while the window holds a change that it could not save", async ({
  ownPage: page,
  isMobile,
}) => {
  // The change is one of live, and the account is connected in the
  // sandbox: what would be lost is not on screen then.
  await switchTo(page, "Live");
  await writeDraft(page, isMobile, "Written while there was room");
  await expectSync(page, "Synced");
  await breakStorage(page);
  await draftRow(page, "Written while there was room").click();
  await editor(page).fill("Written with no room left");
  await expectSync(page, "Not saved · 1 change");
  await backToList(page, isMobile);
  await switchTo(page, "Sandbox");
  await openScreen(page, "Channels");
  await page.getByRole("button", { name: "Connect account" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Mastodon" }).click();
  const next = dialog.getByRole("button", { name: "Continue to Mastodon" });

  // The consent page is another page, and this one would be gone with
  // what it holds. The browser asks, and the person stays.
  //
  // The answer is in place before the click, and is not given after it:
  // a click returns only when the navigations that it began have got
  // somewhere. If the server answers fast enough, leaving for the consent
  // page is one of them, and it gets nowhere before the question is
  // answered. A test that answered after the click would wait for itself.
  const questions: string[] = [];
  page.once("dialog", (question) => {
    questions.push(question.type());
    void question.dismiss();
  });
  await next.click();
  await expect.poll(() => questions).toEqual(["beforeunload"]);

  // The form is theirs again, and not left waiting for a page that does
  // not come.
  await expect(next).toBeEnabled();
  await expect(page).toHaveURL(/\/channels\?add=mastodon$/);
  // The change is still in the window. The dialog is closed first: it
  // hides the switch.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expectElsewhere(page, "Live: Not saved · 1 change");
});

test("disconnecting asks first, and says that the network took the access back", async ({
  ownPage: page,
}) => {
  await openScreen(page, "Channels");
  await connectSimulated(page, grace);
  const disconnect = page.getByRole("button", { name: `Disconnect ${grace}` });

  // The question says what it means, and "Cancel" changes nothing.
  await disconnect.click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText(`Disconnect ${grace}?`);
  await expect(dialog).toContainText(
    "pigy stops posting to this account, and gives the access that it has back to Mastodon",
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(channelRows(page)).toHaveCount(1);
  // The keyboard is back on the button that asked, which opens the
  // question again.
  await expect(disconnect).toBeFocused();

  await page.keyboard.press("Enter");
  await dialog.getByRole("button", { name: "Disconnect" }).click();

  await expect(notice(page)).toHaveText(
    `${grace} is disconnected. Mastodon has taken back the access that pigy had.`,
  );
  await expect(
    page.getByRole("heading", { name: "No accounts connected" }),
  ).toBeVisible();
  // That button is gone now, with the row of the channel. The keyboard is
  // not left on nothing: it is on the button that connects an account,
  // and goes on from there.
  await expect(
    page.getByRole("button", { name: "Connect account" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  const connect = page.getByRole("dialog", { name: "Connect an account" });
  await expect(connect).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(connect).toBeHidden();
  // It is gone for good, not only from this screen: the copy of the
  // workspace has heard of it by the time the app has synced again.
  await page.reload();
  await expectSync(page, "Synced");
  await expect(channelRows(page)).toHaveCount(0);
});

test("disconnecting says what to do when the network did not take the access back", async ({
  ownPage: page,
}) => {
  await openScreen(page, "Channels");
  await connectSimulated(page, grace);
  // The simulated server does take the access back. The request goes
  // through, so that the channel is removed, and the test changes the
  // answer to what a network out of reach leads to.
  await page.route("**/api/workspaces/*/channels/*", async (route) => {
    const response = await route.fetch();
    expect(await response.json()).toEqual({ revoked: true });
    await route.fulfill({ response, json: { revoked: false } });
  });

  await page.getByRole("button", { name: `Disconnect ${grace}` }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Disconnect" })
    .click();

  await expect(alert(page)).toHaveText(
    `${grace} is disconnected, but pigy could not give its access back to Mastodon, where it may still stand. To end it, remove pigy in the settings of the account at Mastodon, under Preferences → Account → Authorized apps.`,
  );
  await expect(channelRows(page)).toHaveCount(0);
});

test("the keyboard goes to the heading after a disconnect that ends without a connection", async ({
  ownPage: page,
}) => {
  // In place before the page is loaded again, which connecting an account
  // does: the sockets that are opened from then on can be cut.
  const connection = await connectionOf(page);
  await openScreen(page, "Channels");
  await connectSimulated(page, grace);
  await expectSync(page, "Synced");
  const release = await holdDisconnect(page);
  await page.getByRole("button", { name: `Disconnect ${grace}` }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("button", { name: "Disconnect" }).click();
  await expect(
    dialog.getByRole("button", { name: "Disconnecting…" }),
  ).toBeDisabled();

  // The connection goes while the request is on its way. Only the socket
  // of the sync does: the answer to the request still comes.
  await connection.cut({ api: true });
  await expect(dialog.getByRole("status")).toContainText("You are offline");
  release();

  // The channel is disconnected, and the screen says so.
  await expect(alert(page)).toContainText(`${grace} is disconnected`);
  await expect(dialog).toBeHidden();
  // After a disconnect the keyboard goes to the button that connects an
  // account. Without a connection that button is disabled, and a disabled
  // button takes no focus: the keyboard would be on nothing, and a screen
  // reader at the top of the page. It is on the heading of the screen.
  await expect(
    page.getByRole("button", { name: "Connect account" }),
  ).toBeDisabled();
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
});

test("a disconnect that is on its way keeps the commands away, and says how it went to somebody who has left the screen", async ({
  ownPage: page,
}) => {
  await openScreen(page, "Channels");
  await connectSimulated(page, grace);
  // Away and back, so that the Back of the browser leads to another
  // screen of the app and not to the consent page.
  await openScreen(page, "Drafts");
  await openScreen(page, "Channels");
  const release = await holdDisconnect(page);
  await page.getByRole("button", { name: `Disconnect ${grace}` }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("button", { name: "Disconnect" }).click();
  await expect(
    dialog.getByRole("button", { name: "Disconnecting…" }),
  ).toBeDisabled();

  // The keys of the command palette do nothing over the question: its
  // commands would take the screen away that the answer is waited for
  // on. The page has dealt with the keys when the press returns, so this
  // looks once.
  await page.keyboard.press("ControlOrMeta+k");
  expect(await page.getByRole("dialog", { name: "Commands" }).count()).toBe(0);
  await expect(dialog).toBeVisible();
  // Neither does the key of "New draft". Both buttons of the question are
  // disabled by now, and a browser takes the focus off a button that is
  // disabled: the key press comes from the page, as if there were no
  // question. This says that it is so here, without which the press below
  // would only repeat what a key press from inside a dialog has always
  // done.
  await expect(page.locator("body")).toBeFocused();
  await page.keyboard.press("c");
  // The command would have written a draft and left for the Drafts
  // screen, a moment after the press. The question is still there, and
  // the draft is looked for below, where it would be listed.
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL("/channels");

  // The browser still goes back. The answer comes when the person is on
  // another screen, and is said there: that pigy is still to be removed
  // at the network is theirs to act on.
  await page.goBack();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Drafts");
  // The key above made no draft. Had it, the way back would not have led
  // here either: the draft would have been one more step in the history.
  await expect(
    page.getByRole("heading", { name: "No drafts yet" }),
  ).toBeVisible();
  release();
  await expect(warningElsewhere(page)).toContainText(
    "remove pigy in the settings of the account at Mastodon",
  );
});

test("the warning of a disconnect that the person has turned away from stays when the workspace changes, until it is closed", async ({
  ownPage: page,
  isMobile,
}) => {
  await openScreen(page, "Channels");
  await connectSimulated(page, grace);
  // Away and back, so that the Back of the browser leads to another
  // screen of the app and not to the consent page.
  await openScreen(page, "Drafts");
  await openScreen(page, "Channels");
  const release = await holdDisconnect(page);
  await page.getByRole("button", { name: `Disconnect ${grace}` }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("button", { name: "Disconnect" }).click();
  await expect(
    dialog.getByRole("button", { name: "Disconnecting…" }),
  ).toBeDisabled();
  // The person leaves the screen, and the answer finds them elsewhere.
  await page.goBack();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Drafts");
  release();
  const warning = warningElsewhere(page);
  await expect(warning).toBeVisible();
  // Next to it, a notice that is about the sandbox: the offer to bring
  // back a draft that was deleted there.
  await writeDraft(page, isMobile, "Deleted in the sandbox");
  await draftRow(page, "Deleted in the sandbox").click();
  await page.getByRole("button", { name: "Delete draft" }).click();
  const offer = page.getByRole("listitem").filter({ hasText: "Draft deleted" });
  await expect(offer).toBeVisible();

  await switchTo(page, "Live");

  // The offer has left with the sandbox, where the draft would be brought
  // back into. That is looked at once: the offer would also leave by
  // itself, some seconds from now. It says that the switch does take
  // notices away, so that the warning is not there only because nothing
  // was.
  expect(await offer.count()).toBe(0);
  // The warning is still there. What is left to do at the network is the
  // person's to do, whichever workspace they look at, and nothing else
  // would tell them. It is under the name of live now, so it says where
  // the account was.
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("In the sandbox workspace.");
  await expect(warning).toContainText(
    "remove pigy in the settings of the account at Mastodon",
  );
  // Until the person closes it.
  await warning.getByRole("button", { name: "Close toast" }).click();
  await expect(warning).toHaveCount(0);
});

test("a connection that was begun for the sandbox ends on the sandbox, also in a tab that shows live", async ({
  ownPage: page,
  context,
}) => {
  await openScreen(page, "Channels");
  await switchTo(page, "Live");
  // The connection is begun for the sandbox while this tab shows live, as
  // another tab would begin it: with a request, and by going where the
  // answer says.
  const consentPage = await page.evaluate(async (server) => {
    const { workspaces } = await (await fetch("/api/workspaces")).json();
    const sandbox = workspaces.find(
      (workspace: { environment: string }) =>
        workspace.environment === "sandbox",
    );
    const response = await fetch(`/api/workspaces/${sandbox.id}/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ network: "mastodon", identifier: server }),
    });
    return (await response.json()).url;
  }, sandboxServer);
  await page.goto(consentPage);

  await page.getByRole("button", { name: grace }).click();

  // The tab shows the workspace that the account was connected to, under
  // its own name, with the account in it.
  await expectWorkspace(page, "Sandbox");
  await expect(notice(page)).toHaveText(
    `Grace Hopper (${grace}) is connected.`,
  );
  await expect(channelRows(page)).toContainText(grace);
  // Nobody chose the sandbox here, so the device goes on remembering
  // live: that is where the next tab starts.
  const next = await context.newPage();
  await next.goto("/channels");
  await expectWorkspace(next, "Live");
  await expect(
    next.getByRole("heading", { name: "No accounts connected" }),
  ).toBeVisible();
});

test("a connection that expired or failed is put in words, once, also for somebody who has to sign in first", async ({
  page,
  ownEmail,
}) => {
  // Where the callback sends somebody whose connection it does not find,
  // which includes everybody who is not signed in.
  await page.goto("/channels?connect=expired&network=mastodon");
  await expect(page).toHaveURL(/^[^?]*\/sign-in\?returnTo=/);
  await signIn(page, ownEmail);

  await expect(alert(page)).toContainText(
    "Nothing was connected: the connection took too long, or it was not begun in this browser.",
  );
  await expect(page).toHaveURL("/channels");
  // Loading the page again does not say it again. The screen is waited
  // for first.
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "No accounts connected" }),
  ).toBeVisible();
  await expect(alert(page)).toHaveCount(0);

  await page.goto("/channels?connect=failed&network=mastodon");
  await expect(alert(page)).toHaveText(
    "Nothing was connected: Mastodon did not give pigy access, or pigy failed. Try again.",
  );
  await expect(page).toHaveURL("/channels");

  // Anybody can make up such an address. What it says beyond the outcome
  // is shown nowhere: a channel is named from the list, and this one is
  // not in it.
  await page.goto(
    "/channels?connect=connected&network=mastodon&channel=Mallory%20was%20here",
  );
  await expect(notice(page)).toHaveText(
    "The account is connected. It appears here as soon as this device has synced.",
  );
  await expect(page.getByRole("main")).not.toContainText("Mallory");
});

test("without a connection the channels are listed from the device, and what needs the server says so", async ({
  ownPage: page,
}) => {
  // In place before the page is loaded again, which connecting an account
  // does: the sockets that are opened from then on can be cut.
  const connection = await connectionOf(page);
  await openScreen(page, "Channels");
  await connectSimulated(page, grace);
  await expectSync(page, "Synced");
  // The form is open when the connection goes.
  await page.getByRole("button", { name: "Connect account" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Mastodon" }).click();
  const next = dialog.getByRole("button", { name: "Continue to Mastodon" });
  await expect(next).toBeEnabled();

  await connection.cut();

  // It says why it leads nowhere now.
  await expect(dialog.getByRole("status")).toContainText(
    "You are offline. Connecting and disconnecting accounts need a connection.",
  );
  await expect(next).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  // So does the screen, which still has the list.
  const offline = page
    .getByRole("main")
    .getByRole("status")
    .filter({ hasText: "You are offline" });
  await expect(offline).toBeVisible();
  await expect(channelRows(page)).toContainText(grace);
  await expect(
    page.getByRole("button", { name: "Connect account" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: `Disconnect ${grace}` }),
  ).toBeDisabled();

  // Also when the app starts without the server: the list is the copy on
  // the device.
  await page.reload();
  await expect(channelRows(page)).toContainText(grace);
  await expect(offline).toBeVisible();

  await connection.restore();
  await expectSync(page, "Synced");
  await expect(offline).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: `Disconnect ${grace}` }),
  ).toBeEnabled();
});

test("a channel that needs reconnecting says so and offers it", async ({
  page,
  ownEmail,
}) => {
  // Nothing sets that status yet: the publishing pipeline will, when a
  // network refuses the access of a channel. So the test changes what the
  // server says about the channels on its way to the page.
  await page.routeWebSocket(/\/sync\//, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => server.send(message));
    server.onMessage((message) =>
      socket.send(
        typeof message === "string"
          ? message.replaceAll(
              '"status":"connected"',
              '"status":"needs_reconnect"',
            )
          : message,
      ),
    );
  });
  await signIn(page, ownEmail);
  await openScreen(page, "Channels");
  await connectSimulated(page, grace);

  await expect(channelRows(page)).toContainText("Needs reconnecting");
  await page.getByRole("button", { name: `Reconnect ${grace}` }).click();

  // The form of the network of the account, with its server filled in.
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(`Reconnect ${grace}`);
  await expect(dialog.getByLabel("Server")).toHaveValue(sandboxServer);
  // There is no other network to choose for an account that exists.
  await expect(dialog.getByRole("button", { name: "Networks" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Continue to Mastodon" }).click();
  await page.getByRole("button", { name: grace }).click();

  // The same account again: one channel, not two.
  await expect(notice(page)).toHaveText(
    `Grace Hopper (${grace}) is connected.`,
  );
  await expect(channelRows(page)).toHaveCount(1);
});

test("the command palette connects an account", async ({ ownPage: page }) => {
  const palette = page.getByRole("dialog", { name: "Commands" });

  // From another screen.
  await page.keyboard.press("ControlOrMeta+k");
  await palette.getByRole("combobox").fill("connect");
  await page.keyboard.press("Enter");

  // The choice of a network, on the screen of the channels: the screen is
  // looked at when the dialog is closed, which hides what is behind it.
  // The dialog is named: the palette can still be on its way out when
  // this one closes, and then there are two.
  await expect(palette).toBeHidden();
  const dialog = page.getByRole("dialog", { name: "Connect an account" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toHaveText("Channels");

  // From the Channels screen itself, the dialog opens over the screen, as
  // the button of the screen opens it. Closing it leaves the history as
  // it was, and one Back leads to where the person was before: had the
  // screen taken the place of the dialog's entry, as it does above, where
  // the Drafts screen was under it, the screen would be in the history
  // twice and this Back would change nothing.
  await page.keyboard.press("ControlOrMeta+k");
  await palette.getByRole("combobox").fill("connect");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL("/channels");
  await page.goBack();
  await expect(heading).toHaveText("Drafts");
});
