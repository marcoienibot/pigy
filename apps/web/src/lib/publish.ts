import {
  countCharacters,
  inReadingOrder,
  type Limits,
  type Row,
  type Tables,
  utf8Length,
  validateContent,
} from "@pigy/core";
import type { Channel } from "@/lib/channels";
import { networkInfo } from "@/lib/networks";

/**
 * What the editor of a draft knows about publishing it: where it can go,
 * where it is to go, and what keeps it from going.
 *
 * Everything here is read from the local copy and checked in the browser,
 * with `validateContent` of `@pigy/core`, which the server checks with
 * before it sends. So nothing is offered that a channel would refuse for
 * its content, and nothing waits for the network.
 */

/** The channels that each draft is to go to, by the ID of its post. */
export type DraftTargets = ReadonlyMap<string, ReadonlySet<string>>;

const noTargets: ReadonlySet<string> = new Set();

/** The channels of every draft: those of its targets. */
export function selectDraftTargets(tables: Tables): DraftTargets {
  const chosen = new Map<string, Set<string>>();
  for (const target of tables.post_target.values()) {
    // Only a draft has targets that are only chosen.
    if (target.status !== "pending") continue;
    const channels = chosen.get(target.postId) ?? new Set();
    channels.add(target.channelId);
    chosen.set(target.postId, channels);
  }
  return chosen;
}

/** The channels that the draft `postId` is to go to. */
export function targetsOf(
  targets: DraftTargets,
  postId: string,
): ReadonlySet<string> {
  return targets.get(postId) ?? noTargets;
}

/** The text of one part: all that the editor checks of it. */
type Text = { readonly text: string };

/**
 * The texts that are written for one account in place of the post's own,
 * by the ID of the post and then of the channel: the parts of each, in
 * the order they are read in. An account that is not in it gets the
 * post's text.
 */
export type OwnTexts = ReadonlyMap<
  string,
  ReadonlyMap<string, readonly Row<"post_part">[]>
>;

const noOwnTexts: ReadonlyMap<string, readonly Row<"post_part">[]> = new Map();

/** The texts that the accounts of every draft get in place of its own. */
export function selectOwnTexts(tables: Tables): OwnTexts {
  const byTarget = new Map<string, Row<"post_part">[]>();
  for (const part of tables.post_part.values()) {
    if (part.targetId === null) continue;
    const parts = byTarget.get(part.targetId);
    if (parts) parts.push(part);
    else byTarget.set(part.targetId, [part]);
  }
  const texts = new Map<string, Map<string, Row<"post_part">[]>>();
  for (const [targetId, parts] of byTarget) {
    const target = tables.post_target.get(targetId);
    // Only a draft has texts to edit. What went out is the Sent screen's.
    if (target?.status !== "pending") continue;
    const ofPost = texts.get(target.postId) ?? new Map();
    ofPost.set(target.channelId, inReadingOrder(parts));
    texts.set(target.postId, ofPost);
  }
  return texts;
}

/** The texts that the accounts of the draft `postId` get in its place. */
export function ownTextsOf(
  texts: OwnTexts,
  postId: string,
): ReadonlyMap<string, readonly Row<"post_part">[]> {
  return texts.get(postId) ?? noOwnTexts;
}

/** One channel, as the editor offers it. */
export type Choice = {
  channel: Channel;
  /** The draft is to go there. */
  chosen: boolean;
  /**
   * The account gets a text that was written for it, and not the post's.
   * Only a chosen account has one.
   */
  own: boolean;
  /**
   * The network no longer takes the access of the channel, which has to be
   * connected again before pigy can post to it. Such a channel cannot be
   * chosen. One that was chosen before can be taken back.
   */
  needsReconnect: boolean;
  /**
   * What the account would refuse in the text that it gets, for people,
   * part by part. Empty when it takes it, and when pigy does not know its
   * limits yet: the server checks before it sends, and the editor does
   * not refuse what it cannot check. A part of the post's own text that is
   * empty is not said here but once, for the draft: `emptyParts`.
   */
  refuses: string[];
  /**
   * The account is chosen and gets a thread, on a network that has none:
   * the parts go out as one post. The editor says so in advance.
   */
  joined: boolean;
  /**
   * Something keeps the account from taking the post, which the editor
   * says in a note next to the choice: it needs connecting again, whether
   * or not it is chosen, or it is chosen and would refuse the text.
   */
  troubled: boolean;
};

/** Why a draft cannot be published as it is. */
export type Blocked =
  /** The workspace has no channel. */
  | "no-channels"
  /** No channel is chosen. */
  | "none-chosen"
  /** A part of the post's text is empty, which no network takes. */
  | "empty"
  /** A chosen channel needs connecting again. */
  | "needs-reconnect"
  /** A chosen channel would refuse the text. */
  | "refused";

export type Composer = {
  /** Every channel of the workspace, in the order of `selectChannels`. */
  choices: Choice[];
  /** How many channels are chosen. */
  chosen: number;
  /**
   * The parts of the post's own text that are empty, counted from 0, if
   * a chosen account gets that text. Otherwise none: an empty text that
   * goes nowhere keeps nothing back.
   */
  emptyParts: number[];
  /** Why "Publish now" is not offered, or null when it is. */
  blocked: Blocked | null;
};

const isEmpty = ({ text }: Text) => text.trim() === "";

/**
 * What the editor shows of a draft with the text `parts` for `channels`,
 * of which those in `chosen` are the ones that the draft is to go to.
 * `own` has the texts that were written for single accounts, by channel:
 * each account is checked on what it will get.
 */
export function compose(
  parts: readonly Text[],
  channels: readonly Channel[],
  chosen: ReadonlySet<string>,
  own: ReadonlyMap<string, readonly Text[]> = noOwnTexts,
): Composer {
  const choices = channels.map((channel): Choice => {
    const isChosen = chosen.has(channel.id);
    const written = isChosen ? own.get(channel.id) : undefined;
    const gets = written ?? parts;
    const refuses: string[] = [];
    // An empty part of the post's own text is said once, for the draft,
    // and not again for every account: no network takes it. In a text
    // that is one account's, it is that account's to be told.
    if (written) {
      gets.forEach((part, index) => {
        if (!isEmpty(part)) return;
        refuses.push(
          gets.length === 1
            ? "Its own text is empty."
            : `Part ${index + 1} of its own text is empty.`,
        );
      });
    }
    if (channel.limits !== null) {
      for (const issue of validateContent(channel.limits, {
        parts: gets.map(({ text }) => ({ text })),
      })) {
        if (issue.code !== "empty") refuses.push(issue.message);
      }
    }
    const needsReconnect = channel.status === "needs_reconnect";
    return {
      channel,
      chosen: isChosen,
      own: written !== undefined,
      needsReconnect,
      refuses,
      joined:
        isChosen &&
        gets.length > 1 &&
        networkInfo[channel.network].thread === "joined",
      troubled: needsReconnect || (isChosen && refuses.length > 0),
    };
  });
  const picked = choices.filter((choice) => choice.chosen);
  const emptyParts = picked.some((choice) => !choice.own)
    ? parts.flatMap((part, index) => (isEmpty(part) ? [index] : []))
    : [];
  return {
    choices,
    chosen: picked.length,
    emptyParts,
    blocked:
      channels.length === 0
        ? "no-channels"
        : picked.length === 0
          ? "none-chosen"
          : emptyParts.length > 0
            ? "empty"
            : picked.some((choice) => choice.needsReconnect)
              ? "needs-reconnect"
              : picked.some((choice) => choice.refuses.length > 0)
                ? "refused"
                : null,
  };
}

/**
 * What the editor says next to the button about a draft of `partCount`
 * parts that cannot be published, or null for one that can.
 */
export function blockedReason(
  { blocked, emptyParts }: Pick<Composer, "blocked" | "emptyParts">,
  partCount: number,
): string | null {
  switch (blocked) {
    case null:
      return null;
    case "no-channels":
      return "Connect an account to publish to.";
    case "none-chosen":
      return "Choose where to publish.";
    case "empty": {
      if (partCount === 1) return "Write something to publish.";
      const [first = 0, ...more] = emptyParts;
      return more.length === 0
        ? `Part ${first + 1} is empty: write something in it, or remove it.`
        : `Parts ${[first, ...more].map((part) => part + 1).join(", ")} are empty: write something in them, or remove them.`;
    }
    case "needs-reconnect":
      return "An account that you chose has to be connected again, or left out.";
    case "refused":
      return "An account that you chose would refuse this post: change the text, or leave the account out.";
  }
}

/**
 * How long a text is for the accounts that share `limits`, as their
 * network counts, against what they take.
 */
export type Meter = {
  /** What tells this counter from the others of the part. */
  key: string;
  /** Whose count it is: the network, and the account where two differ. */
  label: string;
  count: number;
  max: number;
  /**
   * `near` from nine tenths of the limit on, and `over` beyond it: also
   * for a text that is within the characters and over the bytes of a
   * network that limits both.
   */
  tone: "ok" | "near" | "over";
  /** The whole of it in words, for a tooltip and a screen reader. */
  description: string;
};

/** The share of a limit from which a counter warns. */
const nearLimit = 0.9;

/**
 * The limits that a text has to keep, and whose they are: those of
 * `channels`, which are the accounts that get the text, one entry for
 * all accounts with the same limits. An account whose limits pigy does
 * not know yet has none. Made once for a text, and not for each of its
 * parts: `meterOf` then counts a part against each.
 */
export type Gauge = { key: string; label: string; limits: Limits };

export function gaugesOf(
  channels: readonly Pick<Channel, "handle" | "limits">[],
): Gauge[] {
  const gauges = new Map<
    string,
    { limits: Limits; of: Pick<Channel, "handle">[] }
  >();
  for (const channel of channels) {
    if (channel.limits === null) continue;
    const key = JSON.stringify(channel.limits);
    const gauge = gauges.get(key);
    if (gauge) gauge.of.push(channel);
    else gauges.set(key, { limits: channel.limits, of: [channel] });
  }
  const perNetwork = new Map<string, number>();
  for (const { limits } of gauges.values()) {
    perNetwork.set(limits.network, (perNetwork.get(limits.network) ?? 0) + 1);
  }
  return [...gauges].map(([key, { limits, of }]) => {
    const network = networkInfo[limits.network].label;
    return {
      key,
      // Two servers of one network can differ in what they take: then
      // each counter names its accounts.
      label:
        (perNetwork.get(limits.network) ?? 0) > 1
          ? `${network} (${of.map(({ handle }) => handle).join(", ")})`
          : network,
      limits,
    };
  });
}

/** How long `text` is against the limits of `gauge`. */
export function meterOf({ key, label, limits }: Gauge, text: string): Meter {
  const count = countCharacters(limits, text);
  const max = limits.maxCharacters;
  const bytes = "maxBytes" in limits ? utf8Length(text) : 0;
  const tooManyBytes = "maxBytes" in limits && bytes > limits.maxBytes;
  return {
    key,
    label,
    count,
    max,
    tone:
      count > max || tooManyBytes
        ? "over"
        : count >= max * nearLimit
          ? "near"
          : "ok",
    description:
      tooManyBytes && "maxBytes" in limits
        ? `${label}: ${bytes} of ${limits.maxBytes} bytes`
        : `${label}: ${count} of ${max} characters`,
  };
}

/**
 * The accounts that get the text that the editor shows: the one account
 * that `shown` names, for a text of its own, or for null the chosen
 * accounts that get the post's.
 */
export function readersOf(
  choices: readonly Choice[],
  shown: string | null,
): Channel[] {
  return choices
    .filter(({ channel, chosen, own }) =>
      shown === null ? chosen && !own : channel.id === shown,
    )
    .map(({ channel }) => channel);
}

/**
 * Who a post goes to, in a few words: the handle of the one channel, or how
 * many there are.
 */
export function audienceOf(choices: readonly Choice[]): string {
  const picked = choices.filter((choice) => choice.chosen);
  const [only] = picked;
  return picked.length === 1 && only
    ? only.channel.handle
    : `${picked.length} accounts`;
}
