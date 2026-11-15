import {
  backToList,
  breakStorage,
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
  await expect(reload).toBeVisible();
  // The button gives the server ten seconds to come up with a newer
  // version, and loads the page again without one when they are over:
  // rightly so, and as the older version. The test holds the newer one for
  // as long as its next steps take, which is longer than that on a machine
  // that is busy enough. So the clock of the page stands still while the
  // newer version is held, and the ten seconds do not pass.
  const now = Date.now();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now + 1_000);
  await reload.click();

  // The button has the window wait for the newer version: it is the page
  // that was clicked in, and has not begun to load itself again. A reload
  // that asked nobody would have begun in the click, and would bring the
  // older version back, from the device.
  await expect(reload).toBeDisabled();
  expect(await markOf(page)).toEqual({ sameLoad: true, leaving: false });

  installNewer();
  // The clock runs again, for the page that starts: it gives the newer
  // version a time to take over, too.
  await page.clock.resume();

  // Now there is a newer version to start as, and the reload that waited
  // for it does.
  await expect(newerVersion(page)).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Drafts");
});

/** Whether a newer version is installed and waits in the browser of `page`. */
function newerWaits(page: Page): Promise<boolean> {
  return page.evaluate(
    async () =>
      (await navigator.serviceWorker.getRegistration())?.waiting != null,
  );
}

test("a new version does not take over while a window holds changes that it could not store", async ({
  page,
  context,
  ownEmail,
  signInBeforeFirstLoad,
  isMobile,
}) => {
  await signInBeforeFirstLoad(ownEmail);
  await openOlderVersion(page);
  await writeDraft(page, isMobile, "Written while there was room");
  await expectSync(page, "Synced");
  // The device has no room left, as far as this window can tell: what is
  // typed in it now is in the window and nowhere else.
  const storage = await breakStorage(page);
  await draftRow(page, "Written while there was room").click();
  await editor(page).fill("Written with no room left");
  await expectSync(page, "Not saved · 1 change");
  await mark(page);

  // A newer version is found, and is installed behind the window.
  await comeBackTo(page);
  await expect.poll(() => newerWaits(page)).toBe(true);

  // The app is opened in a second window, which would let the newer
  // version take over at any other time. It starts as the older version:
  // a window shows nothing before it has decided, so one that had let the
  // newer version take over would be the newer version here.
  const second = await context.newPage();
  await second.goto("/");
  await expect(second.getByRole("heading", { level: 1 })).toHaveText("Drafts");
  await expect(newerVersion(second)).toHaveCount(0);
  // The newer version still waits. It would not if the second window had
  // asked it to take over and gone on as the older version only because
  // that took too long.
  expect(await newerWaits(second)).toBe(true);
  // The first window is the page that the text was typed in, with the
  // text. Under a service worker of the newer version it would have to
  // choose: load itself again and lose the text, or stay and run a build
  // whose files that worker has deleted.
  expect(await markOf(page)).toEqual({ sameLoad: true, leaving: false });
  await expect(editor(page)).toHaveValue("Written with no room left");
  await expectSync(page, "Not saved · 1 change");

  // The second window knows of the newer version and offers to load it.
  // A reload would start as the older version once more, for the reason
  // that this start did, and make the same offer. So the window stays the
  // page that it is, and says what is in the way.
  await second
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Settings" })
    .click();
  const reloadSecond = second.getByRole("button", { name: "Reload to update" });
  await expect(reloadSecond).toBeVisible();
  await mark(second);
  await reloadSecond.click();
  await expect(
    second.getByText(
      "Another pigy window holds changes that it could not save",
    ),
  ).toBeVisible();
  expect(await markOf(second)).toEqual({ sameLoad: true, leaving: false });
  // To be pressed again when the first window has stored its text: nothing
  // tells the second one when that is.
  await expect(reloadSecond).toBeEnabled();

  // It knows of the newer version and does not offer to load it, which
  // would lose the text as well. The offer is there once the text is
  // stored, so it is the text that keeps it away.
  const nav = page.getByRole("navigation", { name: "Main" });
  const offer = page.getByText("A new version of pigy is ready");
  await backToList(page, isMobile);
  await nav.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Appearance" })).toBeVisible();
  await expect(offer).toHaveCount(0);

  // There is room again, and the window stores the text the next time it
  // tries, which is within five seconds.
  await storage.repair();
  await expect(offer).toBeVisible({ timeout: 15_000 });
  await expectSync(page, "Synced");

  // The second window is started again, and nothing keeps the newer
  // version from taking over now. The first window follows, and has the
  // text: it did not load itself again before the text was stored.
  await second.reload();
  await expect(newerVersion(second)).toHaveCount(1);
  await expect(newerVersion(page)).toHaveCount(1);
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Drafts" })
    .click();
  await expect(draftRow(page, "Written with no room left")).toBeVisible();
});

/**
 * Counts the page loads of `page` and notes when it begins to leave, in
 * what a tab keeps across a reload. Call it before the page is opened.
 */
async function countLoads(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const loads = Number(sessionStorage.getItem("loads") ?? 0) + 1;
    sessionStorage.setItem("loads", String(loads));
    window.addEventListener("beforeunload", () =>
      sessionStorage.setItem("leaving", "yes"),
    );
  });
}

/** What `countLoads` has counted in `page`. */
function loadsOf(page: Page): Promise<{ loads: number; leaving: boolean }> {
  return page.evaluate(() => ({
    loads: Number(sessionStorage.getItem("loads")),
    leaving: sessionStorage.getItem("leaving") === "yes",
  }));
}

/**
 * Notes what `page` asks the caches for, by its path, once the page has
 * had the answer and has acted on it. The note is kept where `countLoads`
 * keeps its own, across a reload. Call it before the page is opened.
 */
async function noteCacheAnswers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const { match } = CacheStorage.prototype;
    CacheStorage.prototype.match = function (request, options) {
      const answer = match.call(this, request, options);
      const settled = () => {
        // This runs before what the page does with the answer: the page
        // gets the promise after this has been put on it. What the page
        // does, it does in the microtasks of the answer, which are over
        // when the next task begins. So the note is made in a task.
        setTimeout(() => {
          const answered: string[] = JSON.parse(
            sessionStorage.getItem("answered") ?? "[]",
          );
          answered.push(
            String(request instanceof Request ? request.url : request),
          );
          sessionStorage.setItem("answered", JSON.stringify(answered));
        });
      };
      answer.then(settled, settled);
      return answer;
    };
  });
}

/** What `noteCacheAnswers` has noted in `page`. */
function cacheAnswersOf(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("answered") ?? "[]"),
  );
}

test("a page that the service worker of its own build takes on stays as it is", async ({
  page,
}) => {
  await countLoads(page);
  await noteCacheAnswers(page);
  // The first page load of the browser: the server answers it, and the
  // service worker is installed behind it.
  await page.goto("/sign-in");
  await serviceWorkerAnswersFor(page);

  // The page asks the caches whether the worker has its build when the
  // worker takes it on, by the script that it was started from, and would
  // load itself again on the answer. Nothing says when that answer comes:
  // the caches promise no order between it and anything that the test
  // could ask them. So the page itself says when it has had the answer
  // and has acted on it, and only then does the test look at what it did.
  // A page that no longer asks fails here too, for want of the note.
  const script = await page.evaluate(() => {
    const element = document.querySelector<HTMLScriptElement>(
      'script[type="module"][src]',
    );
    return element && new URL(element.src).pathname;
  });
  expect(script, "The app shell loads no script").not.toBeNull();
  await expect.poll(() => cacheAnswersOf(page)).toContain(script);
  expect(await loadsOf(page)).toEqual({ loads: 1, leaving: false });
});

test("a page that the service worker of another build takes on loads itself again", async ({
  page,
  context,
}) => {
  // Another build of the app, which is what a device gets when a release
  // is deployed after it has loaded the page and before the page has
  // fetched the service worker. It is made up from the build of the
  // tests, as in `olderVersionFirst`: its service worker with another name
  // for its caches, and with a script of its own in place of the one that
  // the app shell loads.
  const shell = await (await context.request.get("/")).text();
  const script = /<script type="module"[^>]* src="([^"]+)"/.exec(shell)?.[1];
  if (!script) throw new Error("The app shell loads no script");
  const otherScript = "/assets/index-of-another-build.js";
  const build = await (await context.request.get("/sw.js")).text();
  expect(build, "The service worker does not keep the script").toContain(
    script,
  );
  await context.route("**/sw.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: build
        .replaceAll("pigy-app-", "pigy-other-")
        .replaceAll(script, otherScript),
    }),
  );
  // What the server of that build would have: the script, and an app
  // shell that loads it. Only the first service worker of the browser is
  // that build: the browser looks for a newer one behind the test, and
  // finds the build of the tests.
  let first: unknown;
  context.on("serviceworker", (worker) => {
    first ??= worker;
  });
  await context.route(
    (url) => url.pathname === otherScript,
    (route) => route.fulfill({ contentType: "text/javascript", body: "" }),
  );
  await context.route(
    (url) => url.pathname === "/",
    (route) => {
      const worker = route.request().serviceWorker();
      if (!worker || worker !== first) return route.fallback();
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html data-other-build><head><script type="module" src="${otherScript}"></script></head><body>Another build</body></html>`,
      });
    },
  );
  const otherBuild = page.locator("html[data-other-build]");

  // The server answers the first page load, with the build of the tests:
  // only a service worker is ever given the app shell of the other build.
  await page.goto("/sign-in");

  // The service worker of the other build is installed, and takes the
  // page on. The page finds that the worker does not keep its script, and
  // loads itself again: what it shows now is what that worker keeps. A
  // page that stayed would go on as the build of the tests, under a
  // worker that after a real release would not have the code of its next
  // screen.
  await expect(otherBuild).toHaveCount(1);
});
