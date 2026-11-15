import type { Network, Row } from "@pigy/core";

/**
 * What the screens know of a network: what it is called and how an account
 * of it is connected. The Channels screen is made from this table, so a
 * network that pigy learns to connect needs an entry here and nothing in
 * the screen.
 */
type NetworkInfo = {
  label: string;
  /**
   * How an account is connected. Left out for a network whose accounts
   * pigy cannot connect yet: it is listed as coming.
   */
  connect?: {
    /**
     * What a person types to say where their account lives, on a network
     * that asks: the `identifier` of a `ConnectRequest`. Left out for a
     * network with one place to sign in.
     */
    identifier?: {
      /** The name of the field. */
      label: string;
      placeholder: string;
      /** What to enter, under the field. */
      hint: string;
      /** What to enter for the account of `channel`, to connect it again. */
      of(channel: Row<"channel">): string;
    };
    /**
     * Where in the settings of an account its owner ends the access of an
     * app, for when pigy could not give its access back.
     */
    revoke: string;
  };
};

export const networkInfo: Record<Network, NetworkInfo> = {
  mastodon: {
    label: "Mastodon",
    connect: {
      identifier: {
        label: "Server",
        placeholder: "mastodon.social",
        hint: "The address of the server that the account is on, such as mastodon.social.",
        // A handle is "@name@server".
        of: ({ handle }) => handle.slice(handle.lastIndexOf("@") + 1),
      },
      revoke: "Preferences → Account → Authorized apps",
    },
  },
  bluesky: { label: "Bluesky" },
  linkedin: { label: "LinkedIn" },
  threads: { label: "Threads" },
};

/** The networks in the order in which they are listed. */
export const listedNetworks = Object.keys(networkInfo) as Network[];

/** The networks whose accounts can be connected, in that order. */
export const connectableNetworks = listedNetworks.filter(
  (network) => networkInfo[network].connect,
);

/** The names of the networks whose accounts cannot be connected yet. */
export const comingNetworks = listedNetworks
  .filter((network) => !networkInfo[network].connect)
  .map((network) => networkInfo[network].label);
