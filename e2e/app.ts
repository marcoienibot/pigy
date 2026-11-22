import type {
  BrowserContext,
  Locator,
  Page,
  WebSocketRoute,
  Worker,
} from "@playwright/test";
import { expect } from "./fixtures.ts";

/**
 * What the tests of the screens and of sync do over and over. They look at
 * what a person sees, on a desktop and on a phone: where the two differ, a
 * helper takes `isMobile`.
 */

/** Goes to a screen through the navigation of the app. */
export async function openScreen(page: Page, name: string): Promise<void> {
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name })
    .click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
}

/**
 * The switch between live and sandbox, which names the workspace that the
 * page shows. There is one in the sidebar and one in the header of a
 * phone: only the one for this viewport shows.
 */
export function workspaceSwitch(page: Page): Locator {
  return page
    .getByRole("button", { name: /^Workspace: / })
    .filter({ visible: true });
}

/**
 * Waits until `page` shows the workspace `name` and says so: the sandbox
 * with its banner, live without one.
 */
export async function expectWorkspace(
  page: Page,
  name: "Live" | "Sandbox",
): Promise<void> {
  await expect(workspaceSwitch(page)).toHaveAccessibleName(
    `Workspace: ${name}`,
  );
  await expect(page.getByRole("note")).toHaveCount(name === "Sandbox" ? 1 : 0);
}

/**
 * Chooses the workspace `name` with the switch. Not with a draft open on a
 * phone: the editor is over the header then.
 */
export async function switchTo(
  page: Page,
  name: "Live" | "Sandbox",
): Promise<void> {
  await workspaceSwitch(page).click();
  // The option is named by its label and what it says about itself.
  await page
    .getByRole("menuitemradio", { name: new RegExp(`^${name}`) })
    .click();
  await expectWorkspace(page, name);
}

/**
 * Waits until the switch says `note` of the workspace that the page does
 * not show: what this window holds of it that is not saved or not sent, in
 * the words of the sync indicator. With "", until it says nothing.
 */
export async function expectElsewhere(page: Page, note: string): Promise<void> {
  await expect(workspaceSwitch(page)).toHaveAccessibleDescription(note);
}

/** The rows of the list of channels. */
export function channelRows(page: Page): Locator {
  return page.getByRole("list", { name: "Channels" }).getByRole("listitem");
}

/**
 * The simulated Mastodon server that every sandbox starts with, and one of
 * its accounts: `sandboxMastodonDomain` in packages/core/src/sandbox.ts and
 * the accounts in apps/worker/src/sim/object.ts.
 */
export const sandboxServer = "mastodon.example";
export const grace = `@grace@${sandboxServer}`;

/**
 * Begins to connect a simulated Mastodon account from the Channels screen
 * of a sandbox, and stops on the consent page of the simulated server.
 */
export async function openConsentPage(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Connect account" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Mastodon" }).click();
  // The sandbox has filled in its simulated server.
  await dialog.getByRole("button", { name: "Continue to Mastodon" }).click();
  await page.waitForURL(
    ({ pathname }) =>
      pathname === `/sim/network/${sandboxServer}/oauth/authorize`,
  );
}

/**
 * Connects the simulated account `handle` from the Channels screen of a
 * sandbox, as a person does: through the consent page and back.
 */
export async function connectSimulated(
  page: Page,
  handle: string,
): Promise<void> {
  await openConsentPage(page);
  await page.getByRole("button", { name: handle }).click();
  await expect(channelRows(page).filter({ hasText: handle })).toBeVisible();
}

/**
 * A member of the simulated LinkedIn that every sandbox starts with: the
 * accounts in apps/worker/src/sim/object.ts. LinkedIn addresses a member by
 * their name, which is the handle of their channel.
 */
export const graceOnLinkedIn = "Grace Hopper";

/**
 * Connects a member of the simulated LinkedIn from the Channels screen of
 * a sandbox, through the consent page, and ends on the Channels screen
 * with the channel listed. LinkedIn asks for nothing to be typed.
 */
export async function connectSimulatedLinkedIn(
  page: Page,
  name: string,
): Promise<void> {
  await page.getByRole("button", { name: "Connect account" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "LinkedIn" }).click();
  await dialog.getByRole("button", { name: "Continue to LinkedIn" }).click();
  await page.waitForURL(
    ({ pathname }) =>
      pathname === "/sim/network/www.linkedin.com/oauth/v2/authorization",
  );
  await page.getByRole("button", { name }).click();
  await expect(
    channelRows(page).filter({ hasText: "LinkedIn" }).filter({ hasText: name }),
  ).toBeVisible();
}

/** A simulated Bluesky account that every sandbox starts with. */
export const graceOnBluesky = "@grace.bsky.test";

/**
 * Connects the simulated Bluesky account `handle` from the Channels screen
 * of a sandbox, through the consent page of the simulated entryway.
 */
export async function connectSimulatedBluesky(
  page: Page,
  handle: string,
): Promise<void> {
  await page.getByRole("button", { name: "Connect account" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Bluesky" }).click();
  await dialog.getByLabel("Handle").fill(handle);
  await dialog.getByRole("button", { name: "Continue to Bluesky" }).click();
  await page.waitForURL(
    ({ pathname }) => pathname === "/sim/network/bsky.social/oauth/authorize",
  );
  await page.locator('button[name="account"]').getByText(handle).click();
  await expect(channelRows(page).filter({ hasText: handle })).toBeVisible();
}

/**
 * An account of the simulated Threads that every sandbox starts with: the
 * accounts in apps/worker/src/sim/object.ts, by its handle.
 */
export const graceOnThreads = "@grace.sandbox";

/**
 * Connects an account of the simulated Threads from the Channels screen
 * of a sandbox, through the consent page, and ends on the Channels screen
 * with the channel listed. Threads asks for nothing to be typed.
 */
export async function connectSimulatedThreads(
  page: Page,
  handle: string,
): Promise<void> {
  await page.getByRole("button", { name: "Connect account" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Threads" }).click();
  await dialog.getByRole("button", { name: "Continue to Threads" }).click();
  await page.waitForURL(
    ({ pathname }) => pathname === "/sim/network/threads.net/oauth/authorize",
  );
  await page.getByRole("button", { name: handle }).click();
  await expect(
    channelRows(page)
      .filter({ hasText: "Threads" })
      .filter({ hasText: handle }),
  ).toBeVisible();
}

/** The rows of the list of drafts. */
export function draftRows(page: Page): Locator {
  return page.getByRole("list", { name: "Drafts" }).getByRole("link");
}

/** The row of the draft whose title or snippet has `text` in it. */
export function draftRow(page: Page, text: string): Locator {
  return draftRows(page).filter({ hasText: text });
}

/** The text field of the draft that is open. */
export function editor(page: Page): Locator {
  return page.getByRole("textbox", { name: "Draft text" });
}

/**
 * The field of the part `number` of the text that the editor shows, counted
 * from 1: of a thread, which a text is once it has a second part. The one
 * part of a post is `editor`.
 */
export function partField(page: Page, number: number): Locator {
  return page.getByRole("textbox", { name: `Part ${number}`, exact: true });
}

/** The texts of the parts that the editor shows, in their order. */
export function partTexts(page: Page): Promise<string[]> {
  return page
    .getByRole("region", { name: "Draft" })
    .getByRole("textbox")
    .evaluateAll((fields) =>
      fields.map((field) => (field as HTMLTextAreaElement).value),
    );
}

/**
 * The counter of a network under the field `field`: how long its text is
 * the way that network counts, against what the account takes.
 */
export function counterOf(field: Locator, network: string): Locator {
  return field
    .locator("xpath=..")
    .locator("[data-tone]")
    .filter({ hasText: new RegExp(`^${literally(network)} `) });
}

/**
 * The counter of a network that makes one post of a thread, under the
 * last part of the text that the editor shows: how long the parts are
 * together, as that post.
 */
export function wholeCounterOf(page: Page, network: string): Locator {
  return page
    .getByRole("group", { name: "Length of the parts as one post" })
    .locator("[data-tone]")
    .filter({ hasText: new RegExp(`^${literally(network)} `) });
}

/** Where the caret is in the text of the open draft, or the selection. */
export function selectionOf(page: Page): Promise<[number, number]> {
  return editor(page).evaluate((field: HTMLTextAreaElement) => [
    field.selectionStart,
    field.selectionEnd,
  ]);
}

/**
 * Leaves the editor for the list. On a desktop the list is next to the
 * editor, so there is nothing to leave.
 */
export async function backToList(page: Page, isMobile: boolean): Promise<void> {
  if (isMobile) {
    await page.getByRole("button", { name: "Back to drafts" }).click();
  }
}

/** Writes a new draft with `text` and returns to the list. */
export async function writeDraft(
  page: Page,
  isMobile: boolean,
  text: string,
): Promise<void> {
  await page.getByRole("button", { name: "New draft" }).click();
  await editor(page).fill(text);
  await backToList(page, isMobile);
  await expect(draftRow(page, text.split("\n")[0] ?? text)).toBeVisible();
}

/**
 * Waits until the sync indicator says `state`: "Synced", "Offline" and so
 * on. On a phone with a draft open there are two of them, the one of the
 * screen under the one of the editor. They say the same.
 */
export async function expectSync(
  page: Page,
  state: string | RegExp,
): Promise<void> {
  const name =
    typeof state === "string"
      ? `Sync: ${state}`
      : new RegExp(`^Sync: ${state.source}`);
  await expect(
    page
      .getByRole("button", { name, exact: true })
      .filter({ visible: true })
      .first(),
  ).toBeVisible();
}

/**
 * Waits until a service worker of the app answers for `page`. The first
 * one of a browser does from the moment it is installed, which is when it
 * has every file of the app: a page that it answers for can be loaded
 * without a connection.
 */
export async function serviceWorkerAnswersFor(page: Page): Promise<void> {
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

/**
 * Makes the first version of the app that `context` gets an older one than
 * the server has. Call it before a page of the context has opened the app.
 *
 * The server of the tests has one build, so the older version is made up
 * here: the service worker of the build under another name for its caches,
 * which is all that tells two versions apart. Playwright can hand a
 * browser its first service worker. It cannot answer when the browser
 * looks for a newer one: that question goes to the server, which has the
 * build. So the newer version is on the server from the start, and the
 * browser finds it the next time it looks. It looks after every page load
 * that a service worker answers for, and when the app asks it to: until a
 * test wants the newer version found, it moves about in the app and loads
 * no page.
 *
 * For the same reason the page load that installs the older version has
 * to be the first of the browser, which is therefore signed in with
 * `signInBeforeFirstLoad` and not through the sign-in page. Holding the
 * service worker back for the length of a sign-in does not work: that
 * takes a route which fails its registration, and after one of those the
 * Chromium of the tests installs a new service worker with every page
 * load. It does not without a route, when it is a server that fails the
 * registration.
 *
 * What the newer version keeps as its app shell says that it is the newer
 * one, in `newerVersion`.
 *
 * The caches of the older version are not those of a release before the
 * build: under their other name the newer version does not delete them
 * when it takes over, as it deletes those of a real release. A window that
 * stayed behind as the older version would not miss a file here.
 */
export async function olderVersionFirst(context: BrowserContext) {
  const current = await (await context.request.get("/sw.js")).text();
  // What every cache of the app is named with: `prefix` in
  // apps/web/src/sw/precache.ts.
  const older = current.replaceAll("pigy-app-", "pigy-older-");
  expect(
    older,
    "The service worker no longer names its caches with pigy-app-",
  ).not.toBe(current);
  await context.route("**/sw.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: older }),
  );

  // The first service worker of the browser is the older version. Every
  // one after it is the build.
  let first: Worker | undefined;
  context.on("serviceworker", (worker) => {
    first ??= worker;
  });
  // Resolved when the newer version may have its app shell: see
  // `holdNewer`.
  let released: Promise<void> = Promise.resolve();
  await context.route(
    (url) => url.pathname === "/",
    async (route) => {
      // What a service worker keeps as its app shell. A page that asks
      // the server itself gets the build's own, and so does the older
      // version.
      const worker = route.request().serviceWorker();
      if (!worker || worker === first) return route.fallback();
      await released;
      const response = await route.fetch();
      await route.fulfill({
        // Without the headers of the server: the browser would keep this
        // answer, and take it for what the server has later.
        contentType: "text/html; charset=utf-8",
        body: (await response.text()).replace("<html", "<html data-newer"),
      });
    },
  );

  return {
    /**
     * Keeps the newer version from being installed until the function
     * that this returns is called: the browser finds it and begins to
     * install it, and it is left waiting for its app shell. Call this
     * before the browser looks for the newer version.
     */
    holdNewer(): () => void {
      let release = () => {};
      released = new Promise((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

/**
 * The app shell of the newer version, if `page` was loaded from it: see
 * `olderVersionFirst`.
 */
export function newerVersion(page: Page): Locator {
  return page.locator("html[data-newer]");
}

/**
 * Has the browser of `page` offer to install the app, as Chrome does when
 * it has decided that the app can be installed. The browser of the tests
 * never does: it installs nothing. Returns whether the app has kept the
 * browser from showing a banner of its own.
 */
export function offerToInstall(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const offer = Object.assign(
      new Event("beforeinstallprompt", { cancelable: true }),
      {
        prompt: async () => {
          const counter = window as { askedToInstall?: number };
          counter.askedToInstall = (counter.askedToInstall ?? 0) + 1;
        },
      },
    );
    window.dispatchEvent(offer);
    return offer.defaultPrevented;
  });
}

/**
 * Takes control of the connection of `page` to the server, which stays as
 * it is until `cut()`. The page itself and its scripts always load, as
 * they do without a connection: the service worker has them. This is for
 * what `context.setOffline()` cannot do: lose the socket and keep the API,
 * hold changes back, and count the sockets that the page tries to open.
 * Call it before the page opens the app.
 */
export async function connectionOf(page: Page) {
  let online = true;
  let api = true;
  const open = new Set<WebSocketRoute>();
  // Every sync socket that the page has tried to open, cut off or not.
  const attempts: string[] = [];
  // The changes of the page that wait here for `release()`, each as the
  // function that sends it on. Null while changes pass.
  let held: (() => void)[] | null = null;

  await page.routeWebSocket(/\/sync\//, (socket) => {
    attempts.push(socket.url());
    if (!online) {
      // The page sees a handshake that failed.
      void socket.close();
      return;
    }
    open.add(socket);
    // From here on, what the server says passes by itself, and what the
    // page says is passed on below.
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      const pass = () => server.send(message);
      const isChange =
        typeof message === "string" && JSON.parse(message).type === "mutate";
      if (held && isChange) held.push(pass);
      else pass();
    });
  });
  await page.route("**/api/**", (route) =>
    api ? route.fallback() : route.abort(),
  );

  return {
    /** How many sync sockets the page has tried to open. */
    get attempts(): number {
      return attempts.length;
    },

    /**
     * Cuts the page off: the sync socket is lost and no new one gets
     * through. With `api: true`, requests to the API still do, as when
     * only the socket fails. The app then asks the server every time its
     * socket fails again, and hears what has become of the session: a test
     * that ends the session behind its back must not leave the API open.
     */
    async cut(options: { api?: boolean } = {}): Promise<void> {
      online = false;
      api = options.api === true;
      for (const socket of open) await socket.close();
      open.clear();
    },

    /**
     * Holds back the changes that the page sends from now on, until
     * `release()`. Everything else passes, so the page goes on hearing
     * what others change: a test can look at the page while it has a
     * change that the server has not seen, for as long as it takes. The
     * app gives a socket up that leaves a change unanswered for 15 seconds.
     */
    hold(): void {
      held = [];
    },

    /** Sends the changes on that were held back, and lets changes pass. */
    release(): void {
      for (const pass of held ?? []) pass();
      held = null;
    },

    /**
     * Brings the connection back, and tells the page so, as a browser
     * does. Without that the app would find out by itself, after a pause
     * that the test would have to wait for.
     */
    async restore(): Promise<void> {
      online = true;
      api = true;
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
    },
  };
}

/**
 * Makes every write to IndexedDB fail in `page`, as on a device that has
 * no room left, until `repair()` is called. Reading still works.
 */
export async function breakStorage(page: Page) {
  await page.evaluate(() => {
    const { transaction } = IDBDatabase.prototype;
    IDBDatabase.prototype.transaction = function (names, mode, options) {
      if (mode === "readwrite") {
        throw new DOMException("No room left", "QuotaExceededError");
      }
      return transaction.call(this, names, mode, options);
    };
    Object.assign(window, {
      repairStorage() {
        IDBDatabase.prototype.transaction = transaction;
      },
    });
  });
  return {
    repair: () =>
      page.evaluate(() =>
        (window as unknown as { repairStorage(): void }).repairStorage(),
      ),
  };
}

/**
 * Makes every write to IndexedDB in `page` hang, as on a device that is
 * slow to write, until `release()` is called: a write that begins
 * meanwhile is neither stored nor refused before then. With `copyOf`,
 * only the writes to the local copy of that workspace.
 *
 * IndexedDB commits a transaction once it has no request left, so a write
 * that hangs is one that gets another request whenever the last one is
 * answered. It keeps its place in the order of IndexedDB, also for the
 * other windows of the browser: until it is released, they wait for the
 * copy that it writes to.
 */
export async function holdStorage(
  page: Page,
  { copyOf }: { copyOf?: string } = {},
) {
  await page.evaluate((copyOf) => {
    const { transaction } = IDBDatabase.prototype;
    let held = true;
    IDBDatabase.prototype.transaction = function (names, mode, options) {
      const opened = transaction.call(this, names, mode, options);
      if (
        held &&
        mode === "readwrite" &&
        (!copyOf || this.name.endsWith(`/${copyOf}`))
      ) {
        const name = opened.objectStoreNames.item(0);
        if (!name) throw new Error("A write to no object store");
        const busy = () => {
          if (held) opened.objectStore(name).count().onsuccess = busy;
        };
        busy();
      }
      return opened;
    };
    Object.assign(window, {
      releaseStorage() {
        held = false;
        IDBDatabase.prototype.transaction = transaction;
      },
    });
  }, copyOf);
  return {
    release: () =>
      page.evaluate(() =>
        (window as unknown as { releaseStorage(): void }).releaseStorage(),
      ),
  };
}

/**
 * Holds every deletion of an IndexedDB database that `page` asks for from
 * now on, until `release()`: the browser is not asked before then, and
 * the page waits for an answer as it would on a device that is slow. That
 * makes the moment last in which a window has decided to delete the local
 * copies and has not done so. `waiting()` is how many deletions the page
 * has asked for.
 */
export async function holdDeletions(page: Page) {
  type Held = { heldDeletions: { waiting: number; release(): void } };
  await page.evaluate(() => {
    const { deleteDatabase } = IDBFactory.prototype;
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = { waiting: 0, release };
    IDBFactory.prototype.deleteDatabase = function (name) {
      held.waiting += 1;
      // What the page is handed in place of the request, and hears the
      // outcome of the real one on.
      const stand: Pick<IDBOpenDBRequest, "onsuccess" | "onerror"> & {
        error: DOMException | null;
      } = { onsuccess: null, onerror: null, error: null };
      void released.then(() => {
        const request = deleteDatabase.call(this, name);
        request.onsuccess = (event) =>
          stand.onsuccess?.call(request, event as IDBVersionChangeEvent);
        request.onerror = (event) => {
          stand.error = request.error;
          stand.onerror?.call(request, event);
        };
      });
      return stand as IDBOpenDBRequest;
    };
    Object.assign(window, { heldDeletions: held });
  });
  return {
    waiting: () =>
      page.evaluate(() => (window as unknown as Held).heldDeletions.waiting),
    release: () =>
      page.evaluate(() => (window as unknown as Held).heldDeletions.release()),
  };
}

/**
 * Opens a window in the browser of `page` that holds the Web Lock of a
 * window with changes which it has not stored, and that answers nobody: it
 * is a page of the test, on a file of the app, and runs no code of the
 * app. As a window of the app does that the browser has put aside, or
 * that is slow. It holds the lock until it is closed.
 */
export async function silentWindow(page: Page): Promise<Page> {
  const silent = await page.context().newPage();
  await silent.goto("/icon.svg");
  await silent.evaluate(
    () =>
      new Promise<void>((taken) => {
        void navigator.locks.request("pigy/unsaved", { mode: "shared" }, () => {
          taken();
          return new Promise(() => {});
        });
      }),
  );
  return silent;
}

/** The names of the databases with local copies, and the stored session. */
export function localData(page: Page) {
  return page.evaluate(async () => ({
    copies: (await indexedDB.databases())
      .map(({ name }) => name ?? "")
      .filter((name) => name.startsWith("pigy/")),
    session: localStorage.getItem("pigy-session"),
  }));
}

/** The addresses of the sync sockets that `page` opens from now on. */
export function syncSockets(page: Page): string[] {
  const urls: string[] = [];
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname.startsWith("/sync/")) {
      urls.push(socket.url());
    }
  });
  return urls;
}

/** `text` as a pattern that matches it and nothing else. */
function literally(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The part of the editor of a draft that publishes it. */
export function publishPanel(page: Page): Locator {
  return page.getByRole("region", { name: "Publish" });
}

/**
 * The button of the open draft that chooses the channel of `handle`, or
 * leaves it out. It is pressed while the channel is chosen.
 */
export function channelChoice(page: Page, handle: string): Locator {
  return publishPanel(page).getByRole("button", {
    name: new RegExp(`^${literally(handle)} on `),
  });
}

/**
 * Writes a new draft with `text` and publishes it to the channel of
 * `handle` from its editor, as a person does. Starts and ends on the
 * Drafts screen.
 */
export async function publishDraft(
  page: Page,
  text: string,
  handle: string,
): Promise<void> {
  await page.getByRole("button", { name: "New draft" }).click();
  await editor(page).fill(text);
  await channelChoice(page, handle).click();
  await expect(channelChoice(page, handle)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await publishPanel(page).getByRole("button", { name: "Publish now" }).click();
  // A draft that is published is a draft no more: the editor closes.
  await expect(editor(page)).toHaveCount(0);
}

/** The post on the Sent screen whose text has `text` in it. */
export function sentPost(page: Page, text: string): Locator {
  return page
    .getByRole("list", { name: "Sent posts" })
    .getByRole("article", { name: text });
}

/** The delivery of `post`, on the Sent screen, to the channel of `handle`. */
export function deliveryTo(post: Locator, handle: string): Locator {
  return post.getByRole("listitem", { name: handle, exact: true });
}

/** The feed of the simulated account `handle`, on the simulator's screen. */
export function feedOf(page: Page, handle: string): Locator {
  return page.getByRole("region", {
    // After the name of the account, or by itself where the network
    // addresses an account by its name, as LinkedIn does.
    name: new RegExp(`(^| )${literally(handle)}$`),
  });
}

/**
 * Arms a fault from the failure panel of the sandbox: `kind` as the panel
 * calls it, for the next post to `network`.
 */
export async function armFault(
  page: Page,
  network: "Mastodon" | "Bluesky" | "LinkedIn" | "Threads",
  kind: string,
): Promise<void> {
  await openScreen(page, "Simulator");
  await page
    .getByRole("navigation", { name: "Simulator" })
    .getByRole("link", { name: "Failures" })
    .click();
  await page.getByRole("radio", { name: network }).check();
  await page.getByRole("radio", { name: kind, exact: true }).check();
  // Posting is what the panel offers first.
  await expect(page.getByLabel("Which request")).toHaveValue("publish");
  await page.getByRole("button", { name: "Arm", exact: true }).click();
  await expect(page.getByRole("list", { name: "Armed faults" })).toContainText(
    kind,
  );
}

/** How far the page is wider than its window, which it must not be. */
export function overflowOf(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
}

/**
 * Goes to the inbox: by the navigation of the sidebar on a desktop, and by
 * the bell in the header on a phone, whose bar has no room for it.
 */
export async function openInbox(page: Page): Promise<void> {
  await inboxLink(page).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Inbox");
}

/**
 * The way to the inbox that this viewport shows. Its name says how many
 * notifications are unread: "Inbox, 2 unread" on a phone, and "Inbox 2
 * unread" in the sidebar.
 */
export function inboxLink(page: Page): Locator {
  return page.getByRole("link", { name: /^Inbox/ }).filter({ visible: true });
}

/** The notification of the inbox whose words have `text` in them. */
export function inboxItem(page: Page, text: string): Locator {
  return page
    .getByRole("list", { name: "Notifications" })
    .getByRole("listitem")
    .filter({ hasText: text });
}

/** The row of Settings that says how the notifications of the device stand. */
export function notificationsRow(page: Page): Locator {
  return page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Notifications" }) });
}

/**
 * Gives the browser of `context` a push service, which the Chromium of the
 * tests has not: `pushManager.subscribe` fails there. What a page gets
 * when it subscribes is a device that the simulated push service of the
 * e2e build makes up, so the Worker can send to it, and the test can read
 * what it was sent with `receivedBy`. The subscription lasts over a
 * reload, as one of a browser does. Call it before a page of the context
 * has opened the app.
 *
 * The same browser refuses notifications to every site without asking
 * anybody, so the person is stood in for too: they are asked when the app
 * asks the browser, and answer yes, which the browser then remembers.
 */
export async function withPushService(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const kept = "test-push-subscription";
    const answered = "test-notification-permission";
    Object.defineProperty(Notification, "permission", {
      get: () => localStorage.getItem(answered) ?? "default",
    });
    Notification.requestPermission = async () => {
      localStorage.setItem(answered, "granted");
      return "granted";
    };
    const base64Url = (bytes: ArrayBuffer) =>
      btoa(String.fromCharCode(...new Uint8Array(bytes)))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "");
    const subscriptionOf = (stored: {
      key: string;
      json: { endpoint: string };
    }) => ({
      endpoint: stored.json.endpoint,
      options: {
        applicationServerKey: Uint8Array.from(
          atob(stored.key.replaceAll("-", "+").replaceAll("_", "/")),
          (char) => char.charCodeAt(0),
        ).buffer,
      },
      toJSON: () => ({ ...stored.json, expirationTime: null }),
      unsubscribe: async () => {
        localStorage.removeItem(kept);
        return true;
      },
    });
    const manager = PushManager.prototype as unknown as {
      subscribe(options: { applicationServerKey: ArrayBuffer }): unknown;
      getSubscription(): unknown;
    };
    manager.subscribe = async ({ applicationServerKey }) => {
      const key = base64Url(applicationServerKey);
      const response = await fetch("/api/e2e/push/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicationServerKey: key }),
      });
      const stored = { key, json: await response.json() };
      localStorage.setItem(kept, JSON.stringify(stored));
      return subscriptionOf(stored);
    };
    manager.getSubscription = async () => {
      const stored = localStorage.getItem(kept);
      return stored ? subscriptionOf(JSON.parse(stored)) : null;
    };
  });
}

/** The endpoint of the subscription that `withPushService` gave `page`. */
export function pushEndpointOf(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const stored = localStorage.getItem("test-push-subscription");
    return stored ? (JSON.parse(stored).json.endpoint as string) : null;
  });
}

/**
 * The push messages that the device of `page` has received from the
 * Worker, as its browser would have decrypted them: the simulated push
 * service has checked who sent each, and holds the keys of the device.
 */
export async function receivedBy(page: Page): Promise<unknown[]> {
  const endpoint = await pushEndpointOf(page);
  return page.evaluate(async (endpoint) => {
    const response = await fetch("/api/e2e/push/received", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    });
    const { messages } = (await response.json()) as {
      messages: { payload?: string; unreadable?: string }[];
    };
    return messages.map(({ payload, unreadable }) =>
      payload === undefined ? { unreadable } : JSON.parse(payload),
    );
  }, endpoint);
}
