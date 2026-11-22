import {
  cardMaker,
  detectEntities,
  type Network,
  type TextEntity,
} from "@pigy/core";
import { networkInfo } from "@/lib/networks";

/**
 * What the editor of a draft knows of the links, mentions and hashtags of
 * a text: where they are, for the accounts that get the text, and what a
 * network among them takes for plain text. Pure functions over
 * `detectEntities` of `@pigy/core`, which is what the adapters mark up
 * when the post goes out: the editor shows what will be understood.
 */

/** A link, a mention or a hashtag in a text, as the editor marks it. */
export type Mark = {
  kind: TextEntity["kind"];
  /** Where it stands in the text, in UTF-16 code units. */
  start: number;
  end: number;
  /**
   * Whether every network that gets the text understands it. Where one
   * does not, the mark says so, and `markNotes` says which.
   */
  everywhere: boolean;
  /** The address that a link leads to. */
  url?: string;
};

/**
 * The handles that Bluesky was asked about, and which of them are
 * accounts: a mention of one that is not is text there.
 */
export type KnownHandles = {
  asked: ReadonlySet<string>;
  found: ReadonlySet<string>;
};

/** What `network` takes for a link, a mention or a hashtag in `text`. */
function understoodBy(
  network: Network | null,
  text: string,
  known: KnownHandles | null,
): TextEntity[] {
  return detectEntities(network, text).filter(
    (entity) =>
      // Bluesky marks a mention only of a handle that is an account.
      // Until the answer is in, the mention is taken for one.
      !(
        network === "bluesky" &&
        entity.kind === "mention" &&
        known?.asked.has(entity.name) &&
        !known.found.has(entity.name)
      ),
  );
}

const overlaps = (
  a: { start: number; end: number },
  b: { start: number; end: number },
) => a.start < b.end && b.start < a.end;

/**
 * The marks of `text` for accounts of `networks`: what any of them takes
 * for a link, a mention or a hashtag, in the order of the text and none
 * within another. With no network, what any network would take: for a
 * text that goes nowhere yet.
 */
export function marksOf(
  text: string,
  networks: readonly Network[],
  known: KnownHandles | null = null,
): Mark[] {
  const readers: readonly (Network | null)[] =
    networks.length > 0 ? networks : [null];
  const candidates = new Map<string, Mark & { count: number }>();
  for (const network of readers) {
    for (const entity of understoodBy(network, text, known)) {
      const key = `${entity.kind} ${entity.start} ${entity.end}`;
      const candidate = candidates.get(key);
      if (candidate) candidate.count++;
      else {
        candidates.set(key, {
          kind: entity.kind,
          start: entity.start,
          end: entity.end,
          everywhere: false,
          ...(entity.kind === "link" && { url: entity.url }),
          count: 1,
        });
      }
    }
  }
  const marks: Mark[] = [];
  // Where two networks read a stretch differently, the reading that
  // begins first stays, and of two that begin together the longer.
  for (const { count, ...mark } of [...candidates.values()].sort(
    (a, b) => a.start - b.start || b.end - a.end,
  )) {
    if (marks.some((taken) => overlaps(taken, mark))) continue;
    marks.push({ ...mark, everywhere: count === readers.length });
  }
  return marks;
}

/** A stretch of a text: plain, or one of its marks. */
export type Segment = { text: string; mark: Mark | null };

/** `text` cut at its `marks`, which are in order and do not overlap. */
export function segmentsOf(text: string, marks: readonly Mark[]): Segment[] {
  const segments: Segment[] = [];
  let position = 0;
  for (const mark of marks) {
    if (mark.start > position) {
      segments.push({ text: text.slice(position, mark.start), mark: null });
    }
    segments.push({ text: text.slice(mark.start, mark.end), mark });
    position = mark.end;
  }
  if (position < text.length) {
    segments.push({ text: text.slice(position), mark: null });
  }
  return segments;
}

// Why a network takes something for text, by what it is.
const reasons: {
  [Name in Network]: { [Kind in TextEntity["kind"]]: string };
} = {
  bluesky: {
    link: "Bluesky takes it for no address.",
    mention:
      "A mention on Bluesky is the handle of an account, such as @name.bsky.social.",
    hashtag: "A tag on Bluesky is 64 characters at most.",
  },
  linkedin: {
    link: "Write an address with https:// for it to be a link there.",
    mention: "LinkedIn gives pigy no way to mention a member.",
    hashtag: "LinkedIn takes it for no tag.",
  },
  mastodon: {
    link: "Mastodon links an address only with https:// before it.",
    mention: "A mention on Mastodon is @name or @name@server.",
    hashtag: "Mastodon takes it for no tag.",
  },
  threads: {
    link: "Write an address with https:// for it to be a link there.",
    mention: "A mention on Threads is the username of an account.",
    hashtag: "Threads takes one tag per post: the first.",
  },
};

/** "a", "a and b", "a, b and c". */
function listed(items: readonly string[]): string {
  return items.length < 3
    ? items.join(" and ")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * What the accounts of `networks` take for plain text of what looks like
 * a link, a mention or a hashtag in `text`, in words, one note per
 * network and kind. Nothing where every network takes everything.
 */
export function markNotes(
  text: string,
  networks: readonly Network[],
  known: KnownHandles | null = null,
): string[] {
  // What looks like one to anybody: to any of the networks, or to none in
  // particular.
  const looks = [null, ...networks].flatMap((network) =>
    detectEntities(network, text),
  );
  const notes: string[] = [];
  for (const network of new Set(networks)) {
    const understood = understoodBy(network, text, known);
    for (const kind of ["link", "mention", "hashtag"] as const) {
      const plain = new Set<string>();
      const nobody = new Set<string>();
      for (const entity of looks) {
        if (entity.kind !== kind) continue;
        // Taken as it is, or as part of something of the same kind.
        if (
          understood.some(
            (other) => other.kind === kind && overlaps(other, entity),
          )
        ) {
          continue;
        }
        const written = text.slice(entity.start, entity.end);
        const unknown =
          network === "bluesky" &&
          entity.kind === "mention" &&
          known?.asked.has(entity.name.toLowerCase()) &&
          !known.found.has(entity.name.toLowerCase());
        (unknown ? nobody : plain).add(written);
      }
      const { label } = networkInfo[network];
      if (nobody.size > 0) {
        notes.push(
          `${label} has no account ${listed([...nobody])}: ${nobody.size === 1 ? "it stays" : "they stay"} text there.`,
        );
      }
      if (plain.size > 0) {
        notes.push(
          `${listed([...plain])} ${plain.size === 1 ? "is" : "are"} text on ${label}. ${reasons[network][kind]}`,
        );
      }
    }
  }
  return notes;
}

/**
 * The link that a part with `text` is previewed by for accounts of
 * `networks`: its first link, or null.
 */
export function previewLinkOf(
  text: string,
  networks: readonly Network[],
): string | null {
  return (
    marksOf(text, networks).find((mark) => mark.kind === "link")?.url ?? null
  );
}

/**
 * The handles that `text` mentions the way Bluesky reads a mention, each
 * once, sorted: what to ask Bluesky about.
 */
export function blueskyHandlesOf(text: string): string[] {
  return [
    ...new Set(
      detectEntities("bluesky", text).flatMap((entity) =>
        entity.kind === "mention" ? [entity.name] : [],
      ),
    ),
  ].sort();
}

/**
 * Who shows the card of a link, of the accounts of `networks`, in words:
 * pigy sends the card to some networks, and the others read the page
 * themselves.
 */
export function cardNote(networks: readonly Network[]): string {
  const labels = (maker: "pigy" | "network") =>
    [...new Set(networks)]
      .filter((network) => cardMaker[network] === maker)
      .map((network) => networkInfo[network].label)
      .sort();
  const sent = labels("pigy");
  const own = labels("network");
  if (sent.length === 0 && own.length === 0) {
    return "What a network shows of the page that the first link leads to.";
  }
  return [
    sent.length > 0 &&
      `${listed(sent)} ${sent.length === 1 ? "shows" : "show"} this with the post.`,
    own.length > 0 &&
      `${listed(own)} ${own.length === 1 ? "reads" : "read"} the page ${own.length === 1 ? "itself" : "themselves"}, and may show it another way.`,
  ]
    .filter(Boolean)
    .join(" ");
}
