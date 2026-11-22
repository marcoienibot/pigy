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
