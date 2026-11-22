import { useSyncExternalStore } from "react";
import { activateMessage } from "@/sw/messages";
import { keeps } from "@/sw/precache";
import { unsavedInSomeWindow, whenSaved } from "@/sync/workspace-sync";

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
 * - when the person asks to reload, with `reloadToUpdate`, which is such
 *   a start.
 *
 * All windows of a browser share one service worker, and a worker that
 * takes over deletes the files of the build before it. So the rule that
 * everything here keeps is that no window goes on under a worker of
 * another build: the next screen whose code it has not loaded yet would
 * fail. Three things follow from it.
 *
 * - When a new worker takes over, every window that is open loads itself
 *   again. Not before it has stored what was typed in it, which
 *   `whenSaved` waits for: that is over at once, unless the device fails
 *   to store it, and then the window stays as it is until it has.
 * - A window that stays like that would run the old build under the new
 *   worker, so no page that starts lets a new version take over while a
 *   window holds changes which it could not store. Such a window says so
 *   with a Web Lock, see `unsavedInSomeWindow`, and a page that starts
 *   meanwhile starts as the version it is, whose files are all there. A
 *   window that waits after its session has ended holds the same lock,
 *   from the moment it hears of the end until it leaves, also while its
 *   write is only under way and has not failed: it stays for what it has
 *   not stored, as the other does, and no new version takes over under
 *   it either. The
 *   new version goes on waiting: for the last window to go, or for a
 *   start after the changes are stored. A reload that somebody asks for
 *   would be such a start, and bring nothing new: `reloadToUpdate` says so
 *   and leaves the window as it is. What is left is a write that fails in
 *   the instant after a page that starts has looked: that window is under
 *   the new worker until it has stored its changes.
 * - A page that no worker answered for is taken on by the first worker
 *   that is activated. It was loaded from the server, and the worker can
 *   be of another build: one that was deployed before the page had fetched
 *   its worker, or one that takes over from the worker which a reload with
 *   Shift went past. The page looks, and loads itself again if so: see
 *   `takenOn`.
 *
 * The other windows are loaded again without having been asked. That is
 * seldom where the person is: what makes a new version take over is a
 * window that starts or a button that is pressed, and that is where they
 * are. Not always, as with the installed app next to a tab of pigy: what
 * such a window loses is what was on screen only, such as a form that is
 * half filled in. What was typed into a draft is stored. PLAN.md section
 * 19 lists it.
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

/**
 * What `promise` resolves to, or `fallback` if it has not resolved after
 * `ms` milliseconds.
 */
function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

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
 * Loads the page again once it holds no change that is not stored: a
 * service worker of another build answers for it now.
 */
function reloadWhenSaved(): void {
  void whenSaved().then(() => location.reload());
}

/**
 * For a page that no service worker answered for, when one has taken it
 * on: loads the page again if the worker is of another build.
 *
 * It is of this page's build if it keeps the script that the app shell of
 * the page loads, the one that index.html names. The build names a script
 * after its content, and that one names the others, each of which names
 * what it loads: a worker that keeps it keeps every script and stylesheet
 * that this page can still ask for. Not so the file of this module, which
 * stays the same when the code of a screen changes. And only the worker
 * that answers now keeps anything: it has deleted the caches of the others
 * before it took the page on, see the listener for "activate" in
 * src/sw/sw.ts.
 */
async function takenOn(): Promise<void> {
  const script = document.querySelector<HTMLScriptElement>(
    'script[type="module"][src]',
  );
  let own: boolean;
  try {
    own = !script || (await keeps(caches, script.src));
  } catch (error) {
    // The browser does not let the page look. It goes on as before.
    console.error("Service worker", error);
    return;
  }
  if (!own) reloadWhenSaved();
}

/**
 * Whether a page that starts may ask a version that waits to take over.
 * Not while a window holds changes that it could not store: it would have
 * to stay as it is, under a worker of another build.
 *
 * The browser is asked who holds the lock, and the app has no screen
 * before it has answered. It does not always answer: Chromium puts the
 * question off for a page that it renders ahead of time, until somebody
 * opens that page. So the answer is given the time that the take-over
 * itself is given, and without one the page does not ask the version that
 * waits: it starts as the version it is, whose files are all there. A
 * question that fails is another matter: `unsavedInSomeWindow` takes it
 * for a browser without Web Locks, and the page goes ahead, because no
 * window could hold the lock there either.
 */
export function mayTakeOver(): Promise<boolean> {
  return within(
    unsavedInSomeWindow().then((unsaved) => !unsaved),
    takeOverMs,
    false,
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
  let controlled = container.controller !== null;
  const replaced = new Promise<void>((resolve) => {
    container.addEventListener("controllerchange", () => {
      if (controlled) {
        resolve();
        reloadWhenSaved();
      } else {
        // The first worker that this page has. That is a new version only
        // if it is not of the build that the server gave the page.
        controlled = true;
        void takenOn();
      }
    });
  });

  const registration = await container.getRegistration();
  if (controlled && registration?.waiting && (await mayTakeOver())) {
    registration.waiting.postMessage(activateMessage);
    const tookOver = await within(
      replaced.then(() => true),
      takeOverMs,
      false,
    );
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
 *
 * Not before what was typed a moment ago is stored. That is over at once,
 * unless the device fails to store it: a window that holds such changes
 * does not offer the button, and one that comes to hold them after the
 * button was pressed stays, and says "Not saved", until it has stored
 * them.
 *
 * And not while another window holds changes that it could not store. The
 * page that starts would not let the version that waits take over then,
 * see `mayTakeOver`: the reload would bring this version back, with the
 * button that leads nowhere, and a window that is too old for the server
 * would be as old after it. The promise resolves in that case alone, to
 * "blocked", for the button to say why nothing happened. Nothing says
 * when the other window has stored its changes, so the button stays and
 * is pressed again. A browser that does not say who holds the lock is
 * taken the same way, as a page that starts takes it.
 */
export async function reloadToUpdate(): Promise<"blocked"> {
  await within(checkForUpdate(), updateCheckMs, undefined);
  // What this window holds itself comes first, so that the lock which is
  // looked for next is another window's: this one gives its own back when
  // its changes are stored.
  await whenSaved();
  const registration = await container?.getRegistration();
  if (registration?.waiting && !(await mayTakeOver())) return "blocked";
  // Once more, with nothing after it but the reload: something may have
  // been typed while the browser was asked.
  await whenSaved();
  location.reload();
  return new Promise(() => {});
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
