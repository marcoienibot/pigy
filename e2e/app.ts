import type { Locator, Page, WebSocketRoute } from "@playwright/test";
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
 * Takes control of the connection of `page` to the server, which stays as
 * it is until `cut()`. The page itself and its scripts always load: the
 * app does not start without a network before phase 2c. Call this before
 * the page opens the app.
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
