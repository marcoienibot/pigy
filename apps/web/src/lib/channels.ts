import type { ConnectOutcome, Row, Tables } from "@pigy/core";
import { listedNetworks, networkInfo } from "@/lib/networks";
import { dayOf } from "@/lib/time";

/** A connected account, as the Channels screen shows it: its row. */
export type Channel = Row<"channel">;

/**
 * The channels of a workspace, in an order that stays: by network, then
 * by handle.
 */
export function selectChannels(tables: Tables): Channel[] {
  return [...tables.channel.values()].sort(
    (a, b) =>
      listedNetworks.indexOf(a.network) - listedNetworks.indexOf(b.network) ||
      a.handle.localeCompare(b.handle) ||
      (a.id < b.id ? -1 : 1),
  );
}

/**
 * What the Channels screen says of a channel whose access ends by itself,
 * as LinkedIn's does after 60 days, or null for one whose access lasts or
 * is renewed. An access that has ended is said to have: the network
 * refuses the next post, and only then does the channel say that it needs
 * connecting again.
 */
export function accessEnds(
  { expiresAt }: Pick<Channel, "expiresAt">,
  now: number,
): string | null {
  if (expiresAt === null) return null;
  return expiresAt <= now
    ? "Its access has ended: connect the account again."
    : `Its access ends on ${dayOf(expiresAt, now)}: connect the account again before then.`;
}

/** Whether a workspace has no channel. */
export function selectNoChannels(tables: Tables): boolean {
  return tables.channel.size === 0;
}

declare module "@tanstack/react-router" {
  interface HistoryState {
    /**
     * On the entry of the dialog that connects an account: the entry under
     * it in the history of the browser is the Channels screen without the
     * dialog. See `overChannels`.
     */
    overChannels?: true;
  }
}

/**
 * What the entry of the dialog that connects an account says of itself in
 * the history of the browser, when it was added on top of the Channels
 * screen: by a button of that screen, or by the command palette while
 * that screen was shown. Closing the dialog then goes back to the entry
 * under it, which is the screen as it was, and leaves no second entry of
 * the screen behind for Back to go through.
 *
 * An entry without it says nothing about what is under it: the dialog was
 * opened by a link from another screen or from outside the app. The mark
 * is in the state of the entry, which the browser keeps with it: it is
 * still there when the page is loaded again, and it is not there in a tab
 * that was given the address alone.
 */
export const overChannels = { overChannels: true } as const;

/**
 * How a connection ended that has just brought the browser back, from the
 * moment the address said so until the Channels screen is on it. Kept
 * here and not in the address, which is cleaned at once: loading the page
 * again must not say it a second time.
 */
let arrived: ConnectOutcome | undefined;

export function keepConnectOutcome(outcome: ConnectOutcome): void {
  arrived = outcome;
}

/** The outcome that was kept, which is handed out once. */
export function takeConnectOutcome(): ConnectOutcome | undefined {
  const outcome = arrived;
  arrived = undefined;
  return outcome;
}

/** What the Channels screen tells the person, above the list. */
export type Notice = {
  /** `bad` for what did not work and has to be read. */
  tone: "good" | "plain" | "bad";
  text: string;
};

/**
 * What to say of a connection that ended with `outcome`. `channel` is the
 * channel that it names, if the workspace on screen has it.
 *
 * The outcome is the word of an address, which anybody can make up, so
 * every text is one of these and nothing of the address is shown: an
 * account is named only from the row of its channel.
 */
export function connectNotice(
  outcome: ConnectOutcome,
  channel: Channel | undefined,
): Notice {
  const network = outcome.network && networkInfo[outcome.network].label;
  switch (outcome.connect) {
    case "connected":
      return {
        tone: "good",
        text: channel
          ? // A network that addresses an account by its name has it said
            // once.
            channel.handle === channel.name
            ? `${channel.name} is connected.`
            : `${channel.name} (${channel.handle}) is connected.`
          : "The account is connected. It appears here as soon as this device has synced.",
      };
    case "cancelled":
      return {
        tone: "plain",
        text: network
          ? `You cancelled at ${network}. Nothing was connected.`
          : "The connection was cancelled. Nothing was connected.",
      };
    case "expired":
      return {
        tone: "bad",
        text: "Nothing was connected: the connection took too long, or it was not begun in this browser. Start it again from here.",
      };
    case "failed":
      return {
        tone: "bad",
        text: `Nothing was connected: ${network ?? "the network"} did not give pigy access, or pigy failed. Try again.`,
      };
  }
}

/** What to say of the channel of `handle`, which has been disconnected. */
export function disconnectNotice(
  { network, handle }: Pick<Channel, "network" | "handle">,
  revoked: boolean,
): Notice {
  const { label, connect } = networkInfo[network];
  if (revoked) {
    return {
      tone: "good",
      text: `${handle} is disconnected. ${label} has taken back the access that pigy had.`,
    };
  }
  return {
    tone: "bad",
    text: `${handle} is disconnected, but pigy could not give its access back to ${label}, where it may still stand. To end it, remove pigy in the settings of the account at ${label}${
      connect ? `, under ${connect.revoke}` : ""
    }.`,
  };
}
