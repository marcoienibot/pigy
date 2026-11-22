import { maxPartTextLength } from "@pigy/core";
import {
  indexedDbShares,
  type KeptShare,
  keptShareMs,
  maxSharedFileBytes,
  maxSharedFiles,
  type ShareStore,
  sharedFilesParameter,
} from "@/sw/shares";

/**
 * What another app has shared to pigy, as the text that a new draft
 * would have, and the images that it would have. The share target of the
 * manifest posts it to the service worker, which keeps the files on the
 * device and sends the browser to the share screen with the rest in the
 * address, as `title`, `text` and `url`, and with `files`, the name of
 * the kept files: sw/shares.ts. Every app fills the three in its own way:
 * a browser shares a page as its title and its address, many apps put the
 * address at the end of the text and leave `url` empty, some send only a
 * text, and a gallery sends images and nothing else.
 */
export type Shared = {
  title?: string;
  text?: string;
  url?: string;
  /** The name of the files that the service worker keeps for the share. */
  files?: string;
};

/** Whether `text` is an address and nothing else. */
const isAddress = (text: string) => /^https?:\/\/\S+$/i.test(text);

/**
 * The text of the draft that `shared` becomes: what was said, then where
 * it is, each once. Empty if nothing was shared.
 */
export function sharedText(shared: Shared): string {
  const title = shared.title?.trim() ?? "";
  const text = shared.text?.trim() ?? "";
  const url = shared.url?.trim() ?? "";
  const parts: string[] = [];
  // The title of a page is what there is to say when no text came, or
  // when the text is only the address. Next to a text of the person's it
  // would be said twice.
  if (title && (text === "" || isAddress(text)) && title !== text) {
    parts.push(title);
  }
  if (text) parts.push(text);
  if (url && !text.includes(url) && !title.includes(url)) parts.push(url);
  // No longer than a part of a post may be: the mutator would refuse it.
  return parts.join("\n\n").slice(0, maxPartTextLength);
}

/**
 * What the address of a share holds of `title`, `text` and `url`: `query`
 * is the query of that address as the browser has it, with or without
 * its question mark.
 *
 * Read from the address itself, and not from what the router makes of
 * it: the router reads every value as JSON where it can, and what was
 * shared is text. "null" and "[1,2]" would be nothing at all, a long
 * number another number, and a text in quotation marks would lose them.
 */
export function sharedFrom(query: string): Shared {
  const parameters = new URLSearchParams(query);
  const shared: Shared = {};
  for (const name of ["title", "text", "url"] as const) {
    const value = parameters.get(name);
    if (value !== null) shared[name] = value;
  }
  const files = parameters.get(sharedFilesParameter);
  if (files) shared.files = files;
  return shared;
}

/** Whether `shared` holds anything: a text, or files. */
export const sharesSomething = (shared: Shared) =>
  sharedText(shared) !== "" || shared.files !== undefined;

/**
 * Where a tab keeps what was shared to somebody who is signed out, while
 * they sign in: the query of the share's address, as it came.
 *
 * It does not travel through the sign-in with the address to come back
 * to, as it once did: the server keeps no such address of more than
 * 1,000 characters, which a text of 1,200 letters is, or one of 120
 * Chinese characters, and the person arrived at their drafts without it.
 *
 * In `sessionStorage`: it is the tab's, as the address was, and it goes
 * with the tab. It is nobody's data. It came with an address that this
 * tab was opened at before anybody was signed in, so whoever signs in in
 * the tab next is shown it, as they were when the address carried it:
 * signing in is what the share waited for. It is text that the page of
 * somebody else may have supplied, so it is shown and asked about like
 * every share, and stored nowhere else before "Save as draft".
 */
const keptKey = "pigy-share";

/** The storage of the tab, or undefined where the browser has none. */
function tabStorage(): Storage | undefined {
  try {
    return sessionStorage;
  } catch {
    return undefined;
  }
}

/**
 * Keeps what the address with the query `query` shares, for after the
 * sign-in, in the place of whatever was kept before. A query that shares
 * nothing leaves nothing kept. False if the tab could not keep it.
 */
export function keepShared(query: string): boolean {
  try {
    const storage = tabStorage();
    if (!storage) return false;
    if (!sharesSomething(sharedFrom(query))) storage.removeItem(keptKey);
    else storage.setItem(keptKey, query);
    return true;
  } catch {
    return false;
  }
}

/** The query that was kept with `keepShared`, or an empty one. */
export function keptShared(): string {
  try {
    return tabStorage()?.getItem(keptKey) ?? "";
  } catch {
    return "";
  }
}

/**
 * Forgets what was kept: it is saved or discarded, another share has
 * come, or the person has gone elsewhere in the app without deciding.
 * The files of the share that the tab kept, or that its share screen
 * showed, go with it, `showingFiles`, unless they are the files `keep` of
 * a share that has just come, which the screen shows from now on.
 */
export function dropShared(keep?: string): void {
  const kept = sharedFrom(keptShared()).files;
  try {
    tabStorage()?.removeItem(keptKey);
  } catch {
    // Nothing was kept where nothing can be.
  }
  for (const id of new Set([kept, shown])) {
    if (id !== undefined && id !== keep) void forgetFiles(id);
  }
  shown = keep;
}

/** The files of the share that the share screen of this tab shows. */
let shown: string | undefined;

/**
 * Notes that the share screen of this tab shows the files `id`, which
 * `dropShared` then deletes: the screen is left by a navigation, which is
 * where that is called, and not when it is made anew for the other
 * workspace, which shows the same share.
 */
export function showingFiles(id: string | undefined): void {
  shown = id;
}

/** Where the files of shares wait, or undefined without IndexedDB. */
function shares(): ShareStore | undefined {
  try {
    return typeof indexedDB === "undefined"
      ? undefined
      : indexedDbShares(indexedDB);
  } catch {
    return undefined;
  }
}

/**
 * The files that the service worker keeps for the share `id`, or
 * undefined if there are none: they were saved or discarded, their time
 * is over, or the name is not one of this device's.
 */
export async function sharedFiles(id: string): Promise<KeptShare | undefined> {
  try {
    return await shares()?.get(id);
  } catch {
    return undefined;
  }
}

/** Deletes the files of the share `id` from the device. */
export async function forgetFiles(id: string): Promise<void> {
  try {
    await shares()?.delete(id);
  } catch {
    // Gone with the database, or gone by their time.
  }
}

/**
 * Deletes the files of shares that came before `keptShareMs` ago and
 * that no share screen took up: one that was never shown, because nobody
 * signed in, or whose tab was closed on it.
 */
export async function forgetOldShares(now = Date.now()): Promise<void> {
  try {
    await shares()?.prune(now - keptShareMs);
  } catch {
    // Nothing is kept where nothing can be.
  }
}

/** The images of a share that the screen shows, and what it says of the rest. */
export type SharedImages = {
  /** The files that are images that pigy takes, as files of the device. */
  images: File[];
  /** One line for each file that is not taken, and for those that were left. */
  notes: string[];
};

/**
 * The images among the files of `share`, read by `read` as the editor
 * reads a file that is chosen, `readFile` of lib/media.ts: what the
 * device or the app that shared a file said of it counts for nothing. A
 * share whose files are gone says so.
 */
export async function sharedImages(
  share: KeptShare | undefined,
  read: (file: Blob) => Promise<{ facts: unknown } | { refused: string }>,
): Promise<SharedImages> {
  if (!share) {
    return {
      images: [],
      notes: [
        "The images of this share are no longer on this device. Share them again.",
      ],
    };
  }
  const images: File[] = [];
  const notes: string[] = [];
  for (const { name, type, file } of share.files) {
    const image = new File([file], name, { type });
    const found = await read(image);
    if ("facts" in found) images.push(image);
    else notes.push(`${name || "A file"} ${found.refused}.`);
  }
  if (share.left > 0) {
    notes.push(
      `${share.left} more ${share.left === 1 ? "file was" : "files were"} shared. A post takes ${maxSharedFiles} images, of ${maxSharedFileBytes / 1024 / 1024} MB at most each.`,
    );
  }
  return { images, notes };
}
