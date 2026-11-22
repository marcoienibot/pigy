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
 *
 * An access that pigy renews has an end too, as that of Threads has, and
 * that end moves with every renewal: nothing is said of it while it is
 * to come. It is said to have ended when it has, which is when pigy could
 * not renew it in all its weeks.
 */
export function accessEnds(
  { network, expiresAt }: Pick<Channel, "network" | "expiresAt">,
  now: number,
): string | null {
  if (expiresAt === null) return null;
  if (expiresAt <= now) {
    return "Its access has ended: connect the account again.";
  }
  return networkInfo[network].renewsAccess
    ? null
    : `Its access ends on ${dayOf(expiresAt, now)}: connect the account again before then.`;
}

/**
 * Whether a channel has to be connected again before it can be posted to,
 * which is when the Channels screen offers that: its network has refused
 * its access, or the access has ended by its date. The second is not in
 * the status of the channel before a post has been refused for it, and
 * the person need not send one to be offered what the row asks them to do.
 */
export function needsReconnecting(
  { status, expiresAt }: Pick<Channel, "status" | "expiresAt">,
  now: number,
): boolean {
  return (
    status === "needs_reconnect" || (expiresAt !== null && expiresAt <= now)
  );
}

/**
 * The handle of a channel as its row shows it under the name, with the
 * address that it links to, or null where the row has nothing to add to
 * the name: a network that addresses an account by its name, as LinkedIn
 * does, has it said once. A handle that leads somewhere is shown also
 * where it reads like the name, as that of a Bluesky account without a
 * display name does: it is the only link to the profile.
 */
export function handleShown({
  handle,
  name,
  profileUrl,
}: Pick<Channel, "handle" | "name" | "profileUrl">): {
  handle: string;
  url: string | null;
} | null {
  if (handle === name && profileUrl === null) return null;
  return { handle, url: profileUrl };
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
