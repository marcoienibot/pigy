import type { Locator, Page, WebSocketRoute } from "@playwright/test";
import { expect } from "./fixtures.ts";

/**
 * What the tests of the drafts screen and of sync do over and over. They
 * look at what a person sees, on a desktop and on a phone: where the two
 * differ, a helper takes `isMobile`.
 */

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

  await page.routeWebSocket(/\/sync\//, (socket) => {
    attempts.push(socket.url());
    if (!online) {
      // The page sees a handshake that failed.
      void socket.close();
      return;
    }
    open.add(socket);
    // From here on, messages pass in both directions.
    socket.connectToServer();
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
     * through. With `api: false`, requests to the API still do, as when
     * only the socket fails.
     */
    async cut(options: { api?: boolean } = {}): Promise<void> {
      online = false;
      api = options.api === true;
      for (const socket of open) await socket.close();
      open.clear();
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
