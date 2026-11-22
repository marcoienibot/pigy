/**
 * Where the links of a text are. One rule set for all networks, so that
 * what the editor marks, what a counter counts and what an adapter marks
 * up are the same thing:
 *
 * - **A link with a scheme**, "http://" or "https://", is found the way
 *   Mastodon 4.5 finds one, config/initializers/twitter_regex.rb: a host
 *   of labels in any script and a top-level domain, a port, a path and a
 *   query. It does not begin in the middle of a word, a mention or a
 *   hashtag. It does not end in punctuation, so the full stop after a link
 *   is not part of it, and parentheses belong to it only in pairs, one
 *   level deep: "https://example.com/a_(b)" whole, and without the bracket
 *   in "(https://example.com/a)". One difference from Mastodon: it accepts
 *   only the top-level domains that exist, and this accepts any of two or
 *   more ASCII letters, and Punycode. So "https://example.nosuch" is a link
 *   here and plain text there.
 * - **A link without a scheme**, "example.com/page", is found the way
 *   Bluesky's own app finds one: a host in lower case ASCII, after
 *   whitespace or an opening bracket or at the beginning, whose top-level
 *   domain is one of a list, with the same port, path and query as above.
 *   It stands for the same address with "https://". Mastodon links no
 *   such text, so its counting leaves these out, and so does the
 *   detection for every network but Bluesky: entities.ts says why. As in
 *   Bluesky's app, "readme.md" is a link by this rule, because ".md" is a
 *   top-level domain.
 *
 * The patterns do without lookbehind, which older browsers that pigy still
 * opens in cannot compile: what must stand before a match is matched with
 * it, as the first group, and put back.
 */

/** A stretch of a text, in UTF-16 code units, as `String.slice` takes it. */
export type TextRange = { start: number; end: number };

/** A link in a text, with the address that it stands for. */
export type TextLink = TextRange & { url: string };

// The pieces of a link, as in config/initializers/twitter_regex.rb.
const pathChar = String.raw`[^\p{White_Space}<>()?]`;
// Parentheses belong to a link only in pairs, one level deep.
const balanced = String.raw`\((?:${pathChar}+|${pathChar}*\(${pathChar}+\)${pathChar}*)\)`;
// A link does not end in punctuation: the full stop after it is not part
// of it.
const pathEnd = String.raw`(?:[^\p{White_Space}()?!*"'「」<>;:=,.$%\[\]~&|]|${balanced})`;
const path = String.raw`(?:${pathChar}*(?:${balanced}${pathChar}*)*${pathEnd}|${pathChar}+\/)`;
const beyondAscii = String.raw`\u{A0}-\u{D7FF}\u{E000}-\u{FDCF}\u{FDF0}-\u{FFEF}\u{10000}-\u{10FFFD}`;
const queryChar = String.raw`[a-zA-Z0-9!?*'();:&=+$\/%#\[\]\-_.,~|@^${beyondAscii}]`;
const queryEnd = String.raw`[a-zA-Z0-9_&=#\/\-${beyondAscii}]`;
// Anything but whitespace, control characters and ASCII punctuation.
const hostChar = String.raw`[^\p{White_Space}\p{Cc}!-\/:-@\[-\x60{-~]`;
const hostLabel = String.raw`(?:${hostChar}(?:[_-]|${hostChar})*)?${hostChar}\.`;
const topLevelDomain = "(?:[a-zA-Z]{2,}(?![0-9a-zA-Z@+-])|xn--[0-9a-zA-Z]+)";
// What follows the host of a link, with a scheme or without.
const afterHost =
  "(?::[0-9]+)?" +
  String.raw`(?:\/${path}*)?` +
  String.raw`(?:\?${queryChar}*${queryEnd})?`;

const schemedPattern = new RegExp(
  // Not in the middle of a word, a mention or a hashtag.
  "(^|[^a-zA-Z0-9@＠$#＃])" +
    String.raw`([hH][tT][tT][pP][sS]?:\/\/` +
    `(?:${hostLabel})+${topLevelDomain}` +
    `${afterHost})`,
  "gu",
);

/**
 * The top-level domains that a link without a scheme may have. The
 * generic ones that people write, and the two-letter ones of countries
 * and territories. A name that is missing here is a link only with its
 * scheme written out.
 */
const bareTopLevelDomains = (
  "com org net edu gov mil int info biz name pro app dev blog social online " +
  "site xyz tech cloud page news shop store club design art live wiki link " +
  "media email world today life space studio agency network digital systems " +
  "software codes tools zone team work works run fun top one travel museum " +
  "jobs mobi asia cat coop aero eco earth science academy education " +
  "institute foundation community company solutions services consulting " +
  "group global international press pub reviews guide money finance bank " +
  "fund capital exchange market photo photos video film radio music audio " +
  "game games chat forum directory city nyc london berlin paris tokyo africa " +
  "ac ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh " +
  "bi bj bm bn bo br bs bt bw by bz ca cc cd cf cg ch ci ck cl cm cn co cr " +
  "cu cv cw cx cy cz de dj dk dm do dz ec ee eg er es et eu fi fj fk fm fo " +
  "fr ga gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht " +
  "hu id ie il im in io iq ir is it je jm jo jp ke kg kh ki km kn kp kr kw " +
  "ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mg mh mk ml mm mn mo " +
  "mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om " +
  "pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd " +
  "se sg sh si sk sl sm sn so sr ss st su sv sx sy sz tc td tf tg th tj tk " +
  "tl tm tn to tr tt tv tw tz ua ug uk us uy uz va vc ve vg vi vn vu wf ws " +
  "ye yt za zm zw"
).split(" ");

const bareLabel = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";

const barePattern = new RegExp(
  // After whitespace or an opening bracket, or at the beginning: not after
  // the "@" of an address or a mention, and not inside another word.
  String.raw`(^|[\p{White_Space}(])` +
    String.raw`((?:${bareLabel}\.)+` +
    // The longest first, so that "community" is not read as "co".
    `(?:${[...bareTopLevelDomains].sort((a, b) => b.length - a.length).join("|")})` +
    "(?![0-9a-zA-Z@+_-])" +
    `${afterHost})`,
  "gu",
);

/** What `pattern` finds in `text`: the second group of each match. */
function matchesOf(pattern: RegExp, text: string): TextRange[] {
  const ranges: TextRange[] = [];
  for (const match of text.matchAll(pattern)) {
    const start = match.index + (match[1] ?? "").length;
    ranges.push({ start, end: start + (match[2] ?? "").length });
  }
  return ranges;
}

/**
 * Those of `candidates` that overlap none of `taken`. Both are in the
 * order of the text, and those of `taken` do not overlap each other, so
 * one pass over the two does: the work grows with their number and not
 * with its square, which a text of thousands of them would make felt at
 * every key.
 */
export function apartFrom<Range extends TextRange>(
  candidates: readonly Range[],
  taken: readonly TextRange[],
): Range[] {
  const apart: Range[] = [];
  let next = 0;
  for (const candidate of candidates) {
    // What ends before the candidate begins also ends before every
    // candidate after it.
    while (next < taken.length && (taken[next]?.end ?? 0) <= candidate.start) {
      next++;
    }
    const other = taken[next];
    if (other === undefined || other.start >= candidate.end) {
      apart.push(candidate);
    }
  }
  return apart;
}

/** Two lists in the order of the text as one, whose ranges do not overlap. */
export function inOrder<Range extends TextRange>(
  a: readonly Range[],
  b: readonly Range[],
): Range[] {
  const merged: Range[] = [];
  let [i, j] = [0, 0];
  for (;;) {
    const [left, right] = [a[i], b[j]];
    if (left === undefined && right === undefined) return merged;
    if (
      right === undefined ||
      (left !== undefined && left.start <= right.start)
    ) {
      if (left !== undefined) merged.push(left);
      i++;
    } else {
      merged.push(right);
      j++;
    }
  }
}

/**
 * The links of `text`, in their order, none within another. With `bare`,
 * also the ones that are written without a scheme, which stand for the
 * same address with "https://".
 */
export function findLinks(
  text: string,
  { bare: withBare }: { bare: boolean },
): TextLink[] {
  const schemed = matchesOf(schemedPattern, text).map((range) => ({
    ...range,
    url: text.slice(range.start, range.end),
  }));
  if (!withBare) return schemed;
  // A name within a link with a scheme is part of that link, as in
  // "https://a.example/(b.com)".
  const bare = apartFrom(matchesOf(barePattern, text), schemed).map(
    (range) => ({
      ...range,
      url: `https://${text.slice(range.start, range.end)}`,
    }),
  );
  return inOrder(schemed, bare);
}
