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

  // The form of the one network that can be connected, with nothing to
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
  await expect(main).toContainText("Bluesky, LinkedIn, and Threads are coming");
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
    "BlueskyComing soon",
    "LinkedInComing soon",
    "ThreadsComing soon",
  ]);
  await expect(networks.getByRole("button")).toHaveText(["Mastodon"]);

  // Closing leaves the screen as it was, with the address of the screen.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL("/channels");
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
  const asked = page.waitForEvent("dialog");
  await next.click();
  const question = await asked;
  expect(question.type()).toBe("beforeunload");
  await question.dismiss();

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

  await disconnect.click();
  await dialog.getByRole("button", { name: "Disconnect" }).click();

  await expect(notice(page)).toHaveText(
    `${grace} is disconnected. Mastodon has taken back the access that pigy had.`,
  );
  await expect(
    page.getByRole("heading", { name: "No accounts connected" }),
  ).toBeVisible();
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
  await expect(palette).toBeHidden();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Connect an account" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Channels");
});
