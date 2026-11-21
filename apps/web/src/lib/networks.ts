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
   * What the network makes of a post of several parts: a chain of
   * `replies`, each part a post of its own, or one post that the parts
   * are `joined` into, on a network that has no threads. PLAN.md section 6
   * has it for each network.
   */
  thread: "replies" | "joined";
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
     * What a person should know before they connect, said in the form:
     * something of the network's own that is not about what they type.
     */
    note?: string;
    /**
     * Where in the settings of an account its owner ends the access of an
     * app, for when pigy could not give its access back.
     */
    revoke: string;
  };
  /**
   * Where a person finds what their own account has posted, on a network
   * that gives pigy no address of the account: where to look when pigy
   * cannot tell whether a post arrived.
   */
  ownPosts?: string;
  /**
   * pigy can neither look for a post on this network nor ask it a second
   * time without posting twice, so a request to post that ends without a
   * clear answer is not tried again: the delivery is unknown at once, and
   * a person looks. PLAN.md section 8.
   */
  cannotLook?: true;
};

export const networkInfo: Record<Network, NetworkInfo> = {
  mastodon: {
    label: "Mastodon",
    thread: "replies",
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
  bluesky: {
    label: "Bluesky",
    thread: "replies",
    connect: {
      identifier: {
        label: "Handle",
        placeholder: "alice.bsky.social",
        hint: "The handle of the account, such as alice.bsky.social, without the @.",
        // A handle is "@name.domain".
        of: ({ handle }) => handle.replace(/^@/, ""),
      },
      // GUESS: where Bluesky's own servers list the apps that an account
      // has let in. A live run has to confirm it, PLAN.md section 19.
      revoke:
        "the apps of the account at bsky.social/account, for an account on Bluesky's own servers",
    },
  },
  linkedin: {
    label: "LinkedIn",
    thread: "joined",
    // One place to sign in: nothing to type.
    connect: {
      note: "LinkedIn gives its access for 60 days. After that the account has to be connected again, which takes a moment.",
      // GUESS: where LinkedIn lists the apps that a member has let in. A
      // live run has to confirm it, PLAN.md section 19.
      revoke: "Settings & Privacy → Data privacy → Permitted services",
    },
    // GUESS: the address at which LinkedIn shows the member who is signed
    // in what they have posted. PLAN.md section 19.
    ownPosts: "https://www.linkedin.com/in/me/recent-activity/all/",
    cannotLook: true,
  },
  threads: { label: "Threads", thread: "replies" },
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
