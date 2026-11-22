import { maxPartTextLength } from "@pigy/core";

/**
 * What another app has shared to pigy, as the text that a new draft
 * would have. The share target of the manifest hands it over in the address, as `title`,
 * `text` and `url`, and every app fills those in its own way: a browser
 * shares a page as its title and its address, many apps put the address
 * at the end of the text and leave `url` empty, some send only a text.
 */
export type Shared = { title?: string; text?: string; url?: string };

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
  return shared;
}

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
    if (sharedText(sharedFrom(query)) === "") storage.removeItem(keptKey);
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
 */
export function dropShared(): void {
  try {
    tabStorage()?.removeItem(keptKey);
  } catch {
    // Nothing was kept where nothing can be.
  }
}
