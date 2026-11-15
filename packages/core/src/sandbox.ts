import type { Network } from "./network/network.ts";

/**
 * What every sandbox starts with: the simulated networks of a new sandbox
 * workspace, for the Worker to create and for the app to offer.
 */

/**
 * The simulated Mastodon server of a sandbox. It is what a person enters as
 * their server when they connect a Mastodon account there. The name is
 * under `.example`, which no real server can have.
 */
export const sandboxMastodonDomain = "mastodon.example";

/**
 * The simulated server of a sandbox for each network that asks a person
 * where their account lives: what to enter as the `identifier` of a
 * `ConnectRequest` there. A sandbox reaches no other server, whatever the
 * internet has.
 */
export const sandboxServers: { readonly [Name in Network]?: string } = {
  mastodon: sandboxMastodonDomain,
};
