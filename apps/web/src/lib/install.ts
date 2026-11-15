import { useSyncExternalStore } from "react";

/**
 * Installing pigy as an app, as far as a page has a say in it.
 *
 * Chrome, Edge and other browsers on Chromium tell a page that it can be
 * installed, and let it ask the person at a moment of its choosing. pigy
 * offers that in Settings and in the command palette, and nowhere else.
 * Safari has no such thing: there the person adds the page to the Home
 * Screen or the Dock from the menus of the browser, which Settings
 * explains on an iPhone or iPad.
 */

/** The event that offers to install. It is not in TypeScript's types. */
type InstallPromptEvent = Event & { prompt(): Promise<unknown> };

let offer: InstallPromptEvent | undefined;
const listeners = new Set<() => void>();

function set(event: InstallPromptEvent | undefined): void {
  offer = event;
  for (const listener of listeners) listener();
}

// From the first moment of the page: the browser says it once, when it has
// decided that the app can be installed.
window.addEventListener("beforeinstallprompt", (event) => {
  // Otherwise Chrome on Android shows a banner of its own.
  event.preventDefault();
  set(event as InstallPromptEvent);
});
window.addEventListener("appinstalled", () => set(undefined));

/** Asks the person whether to install pigy. An offer is good for once. */
function install(): void {
  const event = offer;
  set(undefined);
  void event?.prompt();
}

/**
 * The function that asks the person whether to install pigy, or undefined
 * where the browser does not offer it: it cannot install, pigy is
 * installed already, or the person has just been asked.
 */
export function useInstall(): (() => void) | undefined {
  const available = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => offer !== undefined,
  );
  return available ? install : undefined;
}

/** Whether this is pigy as an installed app, not a page in a browser. */
export function isInstalled(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // Safari on iOS, for a page that was added to the Home Screen.
    ("standalone" in navigator && navigator.standalone === true)
  );
}

/**
 * Whether this is an iPhone or iPad, where a page is installed from the
 * Share menu of the browser. An iPad says that it is a Mac, one with a
 * touch screen.
 */
export const isIos =
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
