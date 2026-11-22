import { decodeEntities } from "../html.ts";

/**
 * The text of a status from its `content`, which Mastodon gives as HTML:
 * paragraphs for blank lines, `<br>` for line breaks, links and mentions as
 * `<a>` with parts of the address in `<span>`. Taking the tags away leaves
 * the text of a link whole, because Mastodon only hides what it shortens.
 *
 * The result is never put into a page as HTML. It is text, to be compared
 * and shown as text, so what is left of a tag that this does not know is
 * harmless.
 */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>\s*<p\b[^>]*>/gi, "\n\n")
      .replace(/<[^>]*>/g, ""),
  );
}
