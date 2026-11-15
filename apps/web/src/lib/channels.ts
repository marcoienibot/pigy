import type { ConnectOutcome, Row, Tables } from "@pigy/core";
import { listedNetworks, networkInfo } from "@/lib/networks";

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

/** Whether a workspace has no channel. */
export function selectNoChannels(tables: Tables): boolean {
  return tables.channel.size === 0;
}

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
          ? `${channel.name} (${channel.handle}) is connected.`
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
