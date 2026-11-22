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

// What a numeric reference of 0x80 to 0x9F stands for: the character at
// that place in windows-1252, which is what whoever wrote it meant. "Named
// character references", "Numeric character reference end state" of the
// HTML standard. The places that windows-1252 leaves empty stay.
const windows1252: Record<number, number> = {
  128: 0x20ac,
  130: 0x201a,
  131: 0x0192,
  132: 0x201e,
  133: 0x2026,
  134: 0x2020,
  135: 0x2021,
  136: 0x02c6,
  137: 0x2030,
  138: 0x0160,
  139: 0x2039,
  140: 0x0152,
  142: 0x017d,
  145: 0x2018,
  146: 0x2019,
  147: 0x201c,
  148: 0x201d,
  149: 0x2022,
  150: 0x2013,
  151: 0x2014,
  152: 0x02dc,
  153: 0x2122,
  154: 0x0161,
  155: 0x203a,
  156: 0x0153,
  158: 0x017e,
  159: 0x0178,
};

/** What stands for a reference to a character that there is not. */
const replacement = "�";

/**
 * The character that a numeric reference to `codePoint` stands for, as
 * the HTML standard has it: U+FFFD for zero, for half of a surrogate
 * pair and for a number beyond Unicode, none of which is a character.
 * Half a pair in a string is not text that can be sent anywhere.
 */
function referenced(codePoint: number): string {
  if (
    codePoint === 0 ||
    // Also what is too long to be a number.
    !(codePoint <= 0x10ffff) ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return replacement;
  }
  return String.fromCodePoint(windows1252[codePoint] ?? codePoint);
}

/** `text` with the character references of HTML that it holds resolved. */
export function decodeEntities(text: string): string {
  return text.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi,
    (entity, decimal?: string, hex?: string, name?: string) => {
      if (name) return namedEntities[name.toLowerCase()] ?? entity;
      return referenced(
        decimal ? Number.parseInt(decimal, 10) : Number.parseInt(hex ?? "", 16),
      );
    },
  );
}
