import {
  cardLinks,
  cardMaker,
  detectEntities,
  lookedUpMentions,
  maxLookedUpMentions,
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

// What was found in the texts that were asked about last, by network and
// text. The editor asks about the same text many times at every key: for
// its marks, for its notes, for what to ask the server, and for the cards
// of the parts next to it, which have not changed. Each text is looked
// through once per network. A few hundred texts at most: every key of a
// long text makes another one.
const found = new Map<Network | null, Map<string, TextEntity[]>>();
const maxKept = 400;

/**
 * `detectEntities`, which hands out what it found before for a text that
 * it has seen. What it hands out is shared: nobody changes it.
 */
export function detected(network: Network | null, text: string): TextEntity[] {
  let texts = found.get(network);
  if (!texts) {
    texts = new Map();
    found.set(network, texts);
  }
  let entities = texts.get(text);
  if (!entities) {
    if (texts.size >= maxKept) texts.clear();
    entities = detectEntities(network, text);
    texts.set(text, entities);
  }
  return entities;
}

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

/**
 * The handles of `text` that Bluesky is asked about, by the editor and
 * by a post that goes out: `lookedUpMentions` of `@pigy/core`, each once,
 * in the order of the text, ten at most. A mention of any other handle
 * is text on Bluesky, whoever has that handle.
 */
export function lookedUpHandles(text: string): string[] {
  return lookedUpMentions(detected("bluesky", text));
}

/** Why Bluesky takes a mention for text, or null if it takes it for one. */
function blueskyRefuses(
  name: string,
  lookedUp: ReadonlySet<string>,
  known: KnownHandles | null,
): "beyond" | "nobody" | null {
  // Not among the handles that a post looks up: no answer changes that.
  if (!lookedUp.has(name)) return "beyond";
  // Bluesky marks a mention only of a handle that is an account. Until
  // the answer is in, the mention is taken for one.
  return known?.asked.has(name) && !known.found.has(name) ? "nobody" : null;
}

/** What `network` takes for a link, a mention or a hashtag in `text`. */
function understoodBy(
  network: Network | null,
  text: string,
  known: KnownHandles | null,
): TextEntity[] {
  const entities = detected(network, text);
  if (network !== "bluesky") return entities;
  const lookedUp = new Set(lookedUpMentions(entities));
  return entities.filter(
    (entity) =>
      entity.kind !== "mention" ||
      blueskyRefuses(entity.name, lookedUp, known) === null,
  );
}

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
  // begins first stays, and of two that begin together the longer. They
  // are in the order of the text, so one that overlaps a mark that was
  // taken overlaps the last of them.
  let taken = 0;
  for (const { count, ...mark } of [...candidates.values()].sort(
    (a, b) => a.start - b.start || b.end - a.end,
  )) {
    if (mark.start < taken) continue;
    taken = mark.end;
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
  // particular. In the order of the text, as each list is.
  const looks = [null, ...new Set(networks)]
    .flatMap((network) => detected(network, text))
    .sort((a, b) => a.start - b.start);
  // Every handle that the text mentions as Bluesky reads a mention, and
  // the ones among them that are looked up.
  const handles = new Set(
    detected("bluesky", text).flatMap((entity) =>
      entity.kind === "mention" ? [entity.name] : [],
    ),
  );
  const lookedUp = new Set(lookedUpHandles(text));
  const notes: string[] = [];
  for (const network of new Set(networks)) {
    const understood = understoodBy(network, text, known);
    for (const kind of ["link", "mention", "hashtag"] as const) {
      const taken = understood.filter((entity) => entity.kind === kind);
      const plain = new Set<string>();
      const nobody = new Set<string>();
      const beyond = new Set<string>();
      // Both lists are in the order of the text, and what is taken does
      // not overlap itself: one pass over the two.
      let next = 0;
      for (const entity of looks) {
        if (entity.kind !== kind) continue;
        while (next < taken.length && (taken[next]?.end ?? 0) <= entity.start) {
          next++;
        }
        // Taken as it is, or as part of something of the same kind.
        const other = taken[next];
        if (other !== undefined && other.start < entity.end) continue;
        const written = text.slice(entity.start, entity.end);
        // A name that Bluesky reads as a handle and does not mark: it is
        // nobody's, or one too many. Any other name is written in a way
        // that Bluesky does not read.
        const name =
          network === "bluesky" && entity.kind === "mention"
            ? entity.name.toLowerCase()
            : null;
        const refused =
          name !== null && handles.has(name)
            ? blueskyRefuses(name, lookedUp, known)
            : null;
        (refused === "beyond"
          ? beyond
          : refused === "nobody"
            ? nobody
            : plain
        ).add(written);
      }
      const { label } = networkInfo[network];
      if (nobody.size > 0) {
        notes.push(
          `${label} has no account ${listed([...nobody])}: ${nobody.size === 1 ? "it stays" : "they stay"} text there.`,
        );
      }
      if (beyond.size > 0) {
        notes.push(
          `${listed([...beyond])} ${beyond.size === 1 ? "stays" : "stay"} text on ${label}: pigy looks up the first ${maxLookedUpMentions} accounts that a part mentions.`,
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

/** The link of a part that a card is shown for, and who shows it. */
export type Preview = {
  /** The address of the link, with its scheme. */
  link: string;
  /**
   * The networks, of the accounts that get the text, that show the post
   * with the card of this link, sorted. None for a text that goes nowhere
   * yet.
   */
  networks: Network[];
};

/**
 * The cards that the parts with `texts` are shown with for accounts of
 * `networks`: for each part, the links whose cards are shown, each with
 * the networks that show it.
 *
 * Which link that is, is the network's to say, and it is asked of the
 * function that publishing asks, `cardLinks` of `@pigy/core`, over the
 * whole text: an address without its scheme is a link on Bluesky alone,
 * so a part can lead with one link there and with another on LinkedIn.
 * And LinkedIn makes one post of the parts, with one card: that of the
 * first link of them all, shown with the part that the link is in, and
 * with no other. With no network, the first link that any network would
 * take, for a text that goes nowhere yet.
 */
export function previewsOf(
  texts: readonly string[],
  networks: readonly Network[],
): Preview[][] {
  const previews: Preview[][] = texts.map(() => []);
  const add = (index: number, link: string, network: Network | null) => {
    const shown = previews[index];
    if (!shown) return;
    let preview = shown.find((other) => other.link === link);
    if (!preview) {
      preview = { link, networks: [] };
      shown.push(preview);
    }
    if (network !== null) preview.networks.push(network);
  };
  if (networks.length === 0) {
    for (const [index, text] of texts.entries()) {
      const link = detected(null, text).find(({ kind }) => kind === "link");
      if (link?.kind === "link") add(index, link.url, null);
    }
    return previews;
  }
  const [first = "", ...rest] = texts;
  const content = {
    parts: [{ text: first }, ...rest.map((text) => ({ text }))],
  };
  for (const network of [...new Set(networks)].sort()) {
    for (const [index, link] of cardLinks(
      network,
      content,
      detected,
    ).entries()) {
      if (link !== null) add(index, link, network);
    }
  }
  return previews;
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
