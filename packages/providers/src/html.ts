/**
 * What adapters share of reading HTML that somebody else wrote. None of
 * it is ever put into a page as HTML: what comes out is text, to be
 * compared and shown as text.
 */

const namedEntities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

/** `text` with the character references of HTML that it holds resolved. */
export function decodeEntities(text: string): string {
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
