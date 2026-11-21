import { readFileSync } from "node:fs";
import {
  connectionOf,
  draftRow,
  draftRows,
  expectSync,
  openScreen,
  serviceWorkerAnswersFor,
  writeDraft,
} from "../app.ts";
import {
  expect,
  type Page,
  signIn,
  test,
  type WebSocketRoute,
} from "../fixtures.ts";

// The app on a device without a connection: what the service worker has to
// do for it to start, and what the app says where it cannot. Where a test
// has no connection, the whole browser is offline, with
// `context.setOffline()`, and not only the app's own connection as in
// sync-drafts.spec.ts: the page, its scripts and its styles have to come
// from the device. Some tests are about what is not a missing connection:
// a server that answers with an error, and a copy that was never filled.

test("the service worker answers for the app once it is installed", async ({
  signedInPage: page,
}) => {
  await serviceWorkerAnswersFor(page);

  // The page is loaded from what the service worker keeps, not from the
  // server, and it is the worker of the build that does it.
  const response = await page.reload();
  expect(response?.fromServiceWorker()).toBe(true);
  expect(
    await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL),
  ).toBe(new URL("/sw.js", page.url()).href);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Drafts");
});

test("the app starts without a connection, takes a new draft and syncs it when the connection is back", async ({
  ownPage: page,
  context,
  otherDevice,
  isMobile,
}) => {
  await writeDraft(page, isMobile, "Written with a connection");
  await expectSync(page, "Synced");
  await serviceWorkerAnswersFor(page);

  await context.setOffline(true);
  // The app is started again, as from the Home Screen of a phone on a
  // plane: nothing that it asks of the server gets an answer.
  await page.reload();

  await expect(draftRow(page, "Written with a connection")).toBeVisible();
  await expectSync(page, "Offline");
  await writeDraft(page, isMobile, "Written without a connection");
  await expect(draftRows(page)).toHaveCount(2);
  // The draft, and the text that was put in it.
  await expectSync(page, "Offline · 2 changes");
  // A screen whose code the page has not loaded yet: that comes from the
  // device too.
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Settings" })
    .click();
  await expect(page.getByRole("heading", { name: "Appearance" })).toBeVisible();

  await context.setOffline(false);

  await expectSync(page, "Synced");
  const other = await otherDevice();
  await expect(draftRow(other, "Written without a connection")).toBeVisible();
});

test("a screen that is opened by its address works without a connection", async ({
  signedInPage: page,
  context,
}) => {
  await serviceWorkerAnswersFor(page);
  await context.setOffline(true);

  // Not the address that the app was installed from: the app shell
  // answers for every screen.
  await page.goto("/queue");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Queue");

  await page.goto("/no-such-page");
  await expect(
    page.getByRole("heading", { name: "Page not found" }),
  ).toBeVisible();

  // A screen that asks the server for what it shows says that it cannot,
  // and does not take the app down with it.
  await page.goto("/settings/about");
  await expect(page.getByRole("definition").first()).toHaveText("unreachable");
});

/**
 * One path for every pattern in `assets.run_worker_first`, read from where
 * Cloudflare reads them: a path that is added there is tested here without
 * anybody thinking of it. Tested is the service worker of the build that
 * has the list. A device that still runs the one of the release before
 * does not know a pattern that is new: AGENTS.md, "A new path of the
 * Worker".
 */
function workerPaths(): string[] {
  const config = readFileSync(
    new URL("../../apps/worker/wrangler.jsonc", import.meta.url),
    "utf8",
  );
  const list = /"run_worker_first":\s*(\[[^\]]*\])/.exec(config)?.[1];
  if (!list) throw new Error("wrangler.jsonc has no run_worker_first");
  return (JSON.parse(list) as string[])
    .filter((pattern) => !pattern.startsWith("!"))
    .map((pattern) => pattern.replace("*", "no-such-thing"));
}

test("a path of the Worker is never answered with the app shell", async ({
  signedInPage: page,
  context,
}) => {
  await serviceWorkerAnswersFor(page);
  const paths = workerPaths();
  // Otherwise the checks below would pass without looking at anything.
  expect(paths).toContain("/api/no-such-thing");

  // The service worker does answer navigations, and with the app shell:
  // what follows is not true of every address.
  const screen = await page.goto("/queue");
  expect(screen?.fromServiceWorker()).toBe(true);

  for (const path of paths) {
    const response = await page.goto(path);
    expect(response?.fromServiceWorker(), path).toBe(false);
    // The Worker's own answer: an error in JSON, for a path that it does
    // not know or a request that it refuses.
    expect(response?.status(), path).toBeGreaterThanOrEqual(400);
    expect(response?.headers()["content-type"], path).toContain(
      "application/json",
    );
  }

  // Without a connection there is no Worker to answer, and the browser
  // says so. The app shell would show a page of the app that says "not
  // found", or worse, would swallow the return from a sign-in.
  await context.setOffline(true);
  for (const path of paths) {
    await expect(page.goto(path), path).rejects.toThrow(
      "ERR_INTERNET_DISCONNECTED",
    );
  }
});

test("somebody who is not signed in is told that pigy needs a connection", async ({
  page,
  context,
}) => {
  await page.goto("/sign-in");
  const signInLink = page.getByRole("link", { name: "Sign in with Google" });
  await expect(signInLink).toBeVisible();
  await serviceWorkerAnswersFor(page);
  await context.setOffline(true);

  // The app is opened where it starts. The device knows nobody, and the
  // server cannot be asked.
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "pigy cannot reach its server" }),
  ).toBeVisible();
  await expect(page.getByRole("main")).toContainText(
    "signing in takes a connection",
  );

  // The sign-in page says the same, and does not offer the way to Google,
  // which would end on an error page of the browser.
  await page.goto("/sign-in");
  await expect(page.getByRole("status")).toHaveText(
    "pigy cannot reach its server. Signing in takes a connection.",
  );
  await expect(signInLink).toHaveCount(0);

  // The connection is back, and nobody has to press "Try again".
  await context.setOffline(false);
  await expect(signInLink).toBeVisible();
});

/**
 * Has the server answer `page` with an error when it is asked who is
 * signed in, until `recover()` is called. The server answers, and what it
 * says is that something went wrong: nothing that the device could wait
 * for changes that.
 */
async function serverFails(page: Page) {
  let failing = true;
  await page.route("**/api/me", (route) =>
    failing
      ? route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            error: "UnexpectedError",
            message: "The server made a mistake",
          }),
        })
      : route.fallback(),
  );
  return {
    recover(): void {
      failing = false;
    },
  };
}

test("an error of the server is not taken for a missing connection", async ({
  page,
}) => {
  const server = await serverFails(page);

  // The sign-in page says so, and still offers the way to Google: that is
  // a request to the server like any other, and may well work. This
  // device knows of nobody whose place the next person would take. The
  // test below is about a device that does.
  await page.goto("/sign-in");
  await expect(page.getByRole("status")).toContainText(
    "Something went wrong on the server",
  );
  await expect(
    page.getByRole("link", { name: "Sign in with Google" }),
  ).toBeVisible();

  // The app, where it starts, says what the server said, and not that it
  // cannot reach it: it would then wait for a connection that is there.
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Something went wrong" }),
  ).toBeVisible();
  await expect(page.getByRole("main")).toContainText(
    "The server made a mistake",
  );

  // The server has recovered. The person tries again, and is where
  // somebody who is not signed in belongs, without a word about the
  // server.
  server.recover();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page).toHaveURL("/sign-in");
  await expect(
    page.getByRole("link", { name: "Sign in with Google" }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(0);
});

/**
 * Has the server take the question of `page` who is signed in and never
 * answer it, as a network that leads nowhere does, until `answer()` is
 * called. `asked` counts the questions.
 */
async function serverSilent(page: Page) {
  let silent = true;
  const count = { asked: 0, answer: () => {} };
  await page.route("**/api/me", (route) => {
    count.asked += 1;
    // A route that is neither answered nor passed on leaves the request
    // open, which is the point.
    if (!silent) return route.fallback();
  });
  count.answer = () => {
    silent = false;
  };
  return count;
}

test("a server that never answers is taken for one that cannot be reached, on the sign-in page and where the app starts", async ({
  page,
}) => {
  const server = await serverSilent(page);
  // The clock of the page stands still, so that the time which the app
  // gives the server is over when the test says, and not ten seconds
  // later.
  const now = Date.now();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now + 1_000);

  // The sign-in page has nothing to show before it knows whether somebody
  // is signed in. `commit`: the page itself is there, and what it waits
  // for is what the test is about.
  await page.goto("/sign-in", { waitUntil: "commit" });
  await expect.poll(() => server.asked).toBe(1);
  // Not yet: a server that is slow is given its time.
  await page.clock.runFor(9_000);
  await expect(page.getByRole("status")).toHaveCount(0);
  // The time is up. The page says what it says without a connection, and
  // offers no way to Google, which would wait as long.
  await page.clock.runFor(1_000);
  await expect(page.getByRole("status")).toHaveText(
    "pigy cannot reach its server. Signing in takes a connection.",
  );
  await expect(
    page.getByRole("link", { name: "Sign in with Google" }),
  ).toHaveCount(0);

  // The same where the app starts, on a device that knows nobody.
  await page.goto("/", { waitUntil: "commit" });
  await expect.poll(() => server.asked).toBe(2);
  await page.clock.runFor(10_000);
  await expect(
    page.getByRole("heading", { name: "pigy cannot reach its server" }),
  ).toBeVisible();

  // The server answers again, and the person tries again: nobody is
  // signed in, so on to the sign-in page.
  server.answer();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page).toHaveURL("/sign-in");
  await expect(
    page.getByRole("link", { name: "Sign in with Google" }),
  ).toBeVisible();
});

test("a question about the session that is never answered does not keep the app from asking again", async ({
  signedInPage: page,
}) => {
  const server = await serverSilent(page);
  const now = Date.now();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now + 1_000);

  // The device knows who is signed in, so the app starts from that and
  // asks the server in the background: the screen is there although the
  // question is open.
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Drafts");
  expect(server.asked).toBe(1);

  // While the question is open, another navigation asks no second one,
  // also not after the pause that the app keeps between two questions.
  await openScreen(page, "Queue");
  await page.clock.runFor(5_000);
  expect(server.asked).toBe(1);

  // The time of the first question is up. It is given up like one that
  // got no answer, and the next navigation asks again: a session that
  // has ended meanwhile is found out then. Left open for ever, the first
  // question would have been the last of this window.
  await page.clock.runFor(5_000);
  await openScreen(page, "Sent");
  await expect.poll(() => server.asked).toBe(2);
});

test("the sign-in page offers no way to Google over a session that the device still holds", async ({
  signedInPage: page,
}) => {
  // Somebody is signed in on this device, and the server fails when it is
  // asked who: it has not said that the session is over.
  const server = await serverFails(page);

  // The sign-in page says that something went wrong, and that is all. A
  // sign-in as somebody else would take the place of a session that
  // nothing has ended: the app would delete what the device holds of it,
  // changes that were never synced included, without the warning that
  // this page gives when a session has ended.
  await page.goto("/sign-in");
  await expect(page.getByRole("status")).toHaveText(
    "Something went wrong on the server of pigy. Try again in a moment.",
  );
  await expect(
    page.getByRole("link", { name: "Sign in with Google" }),
  ).toHaveCount(0);

  // The server has recovered. The person tries again and is back in the
  // app, signed in as before: the page has not ended the session either.
  server.recover();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Drafts");
});

test("the page that says that pigy cannot start goes on by itself when the connection is back", async ({
  page,
  context,
}) => {
  await page.goto("/sign-in");
  await serviceWorkerAnswersFor(page);
  await context.setOffline(true);
  await page.goto("/queue");
  await expect(
    page.getByRole("heading", { name: "pigy cannot reach its server" }),
  ).toBeVisible();

  await context.setOffline(false);

  // Nobody is signed in, which the server has now said: on to the sign-in
  // page, and from there back to where the person was heading.
  await expect(page).toHaveURL("/sign-in?returnTo=%2Fqueue");
});

test("a device that has not synced yet does not say that there are no drafts", async ({
  page,
  ownEmail,
  otherDevice,
  isMobile,
}) => {
  const other = await otherDevice();
  await writeDraft(other, isMobile, "Written on another device");
  await expectSync(other, "Synced");

  // This device signs in and then cannot open the socket of the workspace:
  // its copy is empty because it has never been filled.
  const connection = await connectionOf(page);
  await connection.cut({ api: true });
  await signIn(page, ownEmail);

  await expect(
    page.getByRole("heading", { name: "Not synced to this device yet" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "No drafts yet" }),
  ).toHaveCount(0);
  await expectSync(page, "Offline");

  await connection.restore();
  await expect(draftRow(page, "Written on another device")).toBeVisible();
});

for (const [why, stop] of [
  [
    // The server closes a socket with 4409 when another one has said hello
    // as the same copy. Nothing connects again after that by itself.
    "another socket has taken its place",
    (socket: WebSocketRoute) =>
      socket.close({ code: 4409, reason: "replaced" }),
  ],
  [
    // As in update.spec.ts.
    "it is too old for the server",
    (socket: WebSocketRoute) => {
      socket.send(
        JSON.stringify({
          type: "error",
          code: "version_mismatch",
          message: "The client and the server speak different versions",
          protocolVersion: 1000,
          schemaVersion: 1,
        }),
      );
      return socket.close({ code: 4400, reason: "version_mismatch" });
    },
  ],
] as const) {
  test(`a device that has not synced yet does not promise the drafts for when it is back online if its window has stopped syncing because ${why}`, async ({
    page,
    ownEmail,
  }) => {
    // The server answers the hello of every sync socket of the page in
    // that way, so the copy of the workspace is never filled.
    await page.routeWebSocket(/\/sync\//, (socket) => {
      socket.onMessage(() => void stop(socket));
    });
    await signIn(page, ownEmail);

    // The copy does not say that there are no drafts, and the drafts will
    // not appear by themselves: what the window needs is a reload, which
    // the sync indicator offers.
    await expect(
      page.getByRole("heading", { name: "Not synced to this device yet" }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "This window has stopped syncing, so your drafts are not on this device yet. The sync indicator says how to go on.",
      ),
    ).toBeVisible();
    await expect(page.getByText(/back online/)).toHaveCount(0);
    await expectSync(page, /Sync paused|Reload to update/);
  });
}
