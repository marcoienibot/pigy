import { type Tables, validateContent } from "@pigy/core";
import type { Channel } from "@/lib/channels";

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

/** One channel, as the editor offers it. */
export type Choice = {
  channel: Channel;
  /** The draft is to go there. */
  chosen: boolean;
  /**
   * The network no longer takes the access of the channel, which has to be
   * connected again before pigy can post to it. Such a channel cannot be
   * chosen. One that was chosen before can be taken back.
   */
  needsReconnect: boolean;
  /**
   * What the account would refuse in the text, for people. Empty when it
   * takes it, and when pigy does not know its limits yet: the server checks
   * before it sends, and the editor does not refuse what it cannot check.
   */
  refuses: string[];
};

/** Why a draft cannot be published as it is. */
export type Blocked =
  /** The workspace has no channel. */
  | "no-channels"
  /** No channel is chosen. */
  | "none-chosen"
  /** The text is empty, which no network takes. */
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
  /** Why "Publish now" is not offered, or null when it is. */
  blocked: Blocked | null;
};

/**
 * What the editor shows of `text` for `channels`, of which those in
 * `chosen` are the ones that the draft is to go to.
 */
export function compose(
  text: string,
  channels: readonly Channel[],
  chosen: ReadonlySet<string>,
): Composer {
  // An empty text is said once, for the draft, and not again for every
  // channel: no network takes it.
  const empty = text.trim() === "";
  const choices = channels.map((channel): Choice => {
    const refuses =
      empty || channel.limits === null
        ? []
        : validateContent(channel.limits, { parts: [{ text }] }).map(
            ({ message }) => message,
          );
    return {
      channel,
      chosen: chosen.has(channel.id),
      needsReconnect: channel.status === "needs_reconnect",
      refuses,
    };
  });
  const picked = choices.filter((choice) => choice.chosen);
  return {
    choices,
    chosen: picked.length,
    blocked:
      channels.length === 0
        ? "no-channels"
        : picked.length === 0
          ? "none-chosen"
          : empty
            ? "empty"
            : picked.some((choice) => choice.needsReconnect)
              ? "needs-reconnect"
              : picked.some((choice) => choice.refuses.length > 0)
                ? "refused"
                : null,
  };
}

/** What the editor says about `blocked`, next to the button. */
export const blockedReasons: Record<Blocked, string> = {
  "no-channels": "Connect an account to publish to.",
  "none-chosen": "Choose where to publish.",
  empty: "Write something to publish.",
  "needs-reconnect":
    "An account that you chose has to be connected again, or left out.",
  refused:
    "An account that you chose would refuse this post: change the text, or leave the account out.",
};

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
