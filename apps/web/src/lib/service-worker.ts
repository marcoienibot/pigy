import { useSyncExternalStore } from "react";
import { activateMessage } from "@/sw/messages";
import { whenSaved } from "@/sync/workspace-sync";

/**
 * The page's side of the service worker in src/sw: registering it, and
 * how a new version of the app takes the place of the one before.
 *
 * The browser looks for a new version after every page load. The app has
 * it look as well when a window comes back to the front, and when the sync
 * server has turned the window away as too old. A new version is installed
 * next to the one that is running, and waits. It never takes over by
 * itself: the windows that are open were loaded from the version before,
 * and somebody may be typing in one. It takes over
 *
 * - when the last window of the app has been closed, which the browser
 *   sees to, so that the next start is the new version,
 * - when the app is started while it waits: the page that starts says so
 *   before it has put anything on screen, and starts again as the new
 *   version, or
 * - when the person asks to reload, with `reloadToUpdate`.
 *
 * All windows of a browser share one service worker. When a new one takes
 * over, every window that is open loads itself again, so that none goes on
 * as the old version under the new worker, which does not have its files.
 * A window does that at once unless it holds changes that it could not
 * store: those would be lost, so it waits for them. The window that is
 * loaded again without having asked is never the one that somebody is
 * typing in: what makes a new version take over is a window that starts
 * or a button that is pressed, and that is where the person is.
 */

/**
 * Not in `pnpm dev`, which builds no service worker, and not where the
 * browser has none, such as a private window of Firefox.
 */
const container =
  import.meta.env.PROD && "serviceWorker" in navigator
    ? navigator.serviceWorker
    : undefined;

/**
 * How long a page that starts waits for a version that was waiting to take
 * over, in milliseconds, before it goes on as the version it is. Chromium
 * takes about a second, in which it lets the worker before finish what it
 * is doing. This is for a worker that fails to take over. If it only takes
 * longer, the page is loaded again when it has.
 */
const takeOverMs = 3_000;

/**
 * How long `reloadToUpdate` waits to hear whether there is a new version,
 * in milliseconds. A network that is up and leads nowhere can leave the
 * question open for minutes.
 */
const updateCheckMs = 10_000;

/** Whether a newer version of the app is installed and waits. */
let ready = false;
const listeners = new Set<() => void>();

function watch(registration: ServiceWorkerRegistration): void {
  const look = () => {
    // The first service worker of a device waits for nobody.
    if (ready || !registration.waiting || !registration.active) return;
    ready = true;
    for (const listener of listeners) listener();
  };
  const follow = (worker: ServiceWorker | null) =>
    worker?.addEventListener("statechange", look);
  look();
  // One that the browser found before this page began to watch.
  follow(registration.installing);
  registration.addEventListener("updatefound", () =>
    follow(registration.installing),
  );
}

/**
 * Starts the service worker, before the app renders. If a newer version of
 * the app was waiting, it takes over now and the page is loaded again:
 * the promise does not resolve then. It rejects if the browser refuses to
 * say what it has registered, which is no reason not to start the app.
 */
export async function startServiceWorker(): Promise<void> {
  if (!container) return;
  // A page that no service worker answers for was loaded from the server.
  // The first worker that is installed takes it on, and that is no new
  // version.
  let controlled = container.controller !== null;
  const replaced = new Promise<void>((resolve) => {
    container.addEventListener("controllerchange", () => {
      if (controlled) {
        resolve();
        void whenSaved().then(() => location.reload());
      }
      controlled = true;
    });
  });

  const registration = await container.getRegistration();
  if (controlled && registration?.waiting) {
    registration.waiting.postMessage(activateMessage);
    const tookOver = await Promise.race([
      replaced.then(() => true),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), takeOverMs),
      ),
    ]);
    if (tookOver) return new Promise(() => {});
  }

  // Not awaited: the first time, this is over when the worker has been
  // fetched, and the app does not wait for that.
  container
    .register("/sw.js")
    .then(watch)
    .catch((error: unknown) => console.error("Service worker", error));
  // Somebody who comes back to a window that has been open for days is
  // told of a version that has come out since.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void checkForUpdate();
  });
}

/**
 * Asks the server whether there is a newer version of the app, and waits
 * until it is installed if there is. Without a connection there is no
 * news.
 */
export async function checkForUpdate(): Promise<void> {
  const registration = await container?.getRegistration();
  if (!registration) return;
  try {
    await registration.update();
  } catch {
    return;
  }
  const worker = registration.installing;
  if (!worker) return;
  // From "installing" a worker goes on to "installed", or fails.
  await new Promise<void>((resolve) => {
    worker.addEventListener("statechange", () => resolve(), { once: true });
  });
}

/**
 * Loads the app again, as its newest version if the server can be asked
 * for it: the page that starts lets a version that waits take over, see
 * `startServiceWorker`. For a button that says "Reload".
 */
export async function reloadToUpdate(): Promise<void> {
  await Promise.race([
    checkForUpdate(),
    new Promise((resolve) => setTimeout(resolve, updateCheckMs)),
  ]);
  location.reload();
}

/** Whether a newer version of the app is installed and waits. */
export function useUpdateReady(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => ready,
  );
}
