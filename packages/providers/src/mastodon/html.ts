const namedEntities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

function decodeEntities(text: string): string {
  return text.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi,
    (entity, decimal?: string, hex?: string, name?: string) => {
      if (name) return namedEntities[name.toLowerCase()] ?? entity;
      const codePoint = decimal
        ? Number.parseInt(decimal, 10)
        : Number.parseInt(hex ?? "", 16);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
    },
  );
}

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
