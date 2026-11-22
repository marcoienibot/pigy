import { useSyncExternalStore } from "react";

/**
 * Whether the browser has promised to keep what pigy stores on this
 * device: the local copies in IndexedDB, with the changes that were never
 * synced, and the files of the app. Without the promise a browser may
 * delete all of it when the device runs low on space, without a word.
 *
 * `unknown` where the browser does not say: it has no such promise to
 * give, or the question failed.
 */
export type Kept = "kept" | "not-kept" | "unknown";

/** What this module uses of `navigator.storage`. */
export type DeviceStorage = Partial<
  Pick<StorageManager, "persist" | "persisted">
>;

/** What the browser says now, without asking it for anything. */
export async function keptBy(
  storage: DeviceStorage | undefined,
): Promise<Kept> {
  if (!storage?.persisted) return "unknown";
  try {
    return (await storage.persisted()) ? "kept" : "not-kept";
  } catch {
    return "unknown";
  }
}

/**
 * Asks the browser to keep what pigy stores, unless it has promised to
 * already, and returns what it says then. Chrome decides by itself, by how
 * much the app is used and whether it is installed, so the answer can be
 * another one later. Firefox asks the person.
 */
export async function askToKeep(
  storage: DeviceStorage | undefined,
): Promise<Kept> {
  const before = await keptBy(storage);
  if (before !== "not-kept" || !storage?.persist) return before;
  try {
    return (await storage.persist()) ? "kept" : "not-kept";
  } catch {
    return "not-kept";
  }
}

/** A page that is not served securely has no `navigator.storage`. */
function deviceStorage(): DeviceStorage | undefined {
  return navigator.storage;
}

/** What the browser last said, or undefined before it has said anything. */
let kept: Kept | undefined;
const listeners = new Set<() => void>();

function say(answer: Kept): void {
  kept = answer;
  for (const listener of listeners) listener();
}

/**
 * Asks the browser to keep what pigy stores on this device, and tells
 * whoever shows the answer. For a button: the person has asked for it.
 * It returns the answer, for the button to say when nothing has changed:
 * a browser that decides by itself refuses without a word.
 */
export async function keepOnDevice(): Promise<Kept> {
  const answer = await askToKeep(deviceStorage());
  say(answer);
  return answer;
}

let asked = false;

/**
 * Asks as `keepOnDevice` does, once per page load, when the person changes
 * something: from then on the device may hold what the server does not
 * have. Not when the app starts: nothing waits for the answer, and a
 * browser that asks the person, as Firefox does, asks while they are at
 * work in the app and not before they have seen it. It is asked again
 * with the first change after every page load, because a browser that
 * decides by itself, as Chrome does, may decide otherwise by then. Once
 * the browser has promised, nothing is asked.
 */
export function keepOnDeviceOnce(): void {
  if (asked) return;
  asked = true;
  void keepOnDevice();
}

/**
 * How long a screen waits for the browser to say whether it keeps the
 * data, in milliseconds: see `readKept`. A browser answers at once.
 */
const readKeptMs = 500;

/**
 * Reads what the browser says now, without asking it for anything, for
 * `useKept`. For the loader of a screen that shows it: the answer is
 * there when the screen is first drawn, so nothing appears a moment
 * later and moves what is on screen. A browser that takes longer than
 * `readKeptMs` is not waited for, and its answer is shown when it comes.
 */
export async function readKept(): Promise<void> {
  const read = keptBy(deviceStorage()).then(say);
  await Promise.race([
    read,
    new Promise((resolve) => setTimeout(resolve, readKeptMs)),
  ]);
}

/**
 * What the browser says about keeping what pigy stores on this device, for
 * a screen whose loader has called `readKept`. Undefined if the browser
 * has not answered yet.
 */
export function useKept(): Kept | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => kept,
  );
}
