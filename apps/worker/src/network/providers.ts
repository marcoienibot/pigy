import type { Clock, Fetch, Network } from "@pigy/core";
import type { Provider } from "@pigy/providers";
import { createBlueskyProvider } from "@pigy/providers/bluesky";
import { createLinkedInProvider } from "@pigy/providers/linkedin";
import { createMastodonProvider } from "@pigy/providers/mastodon";
import { createThreadsProvider } from "@pigy/providers/threads";
import { drizzle } from "drizzle-orm/d1";
import type { Bindings } from "../env.ts";
import type { Vault } from "../vault.ts";
import type { WorkspaceIdentity } from "../workspace/store.ts";
import {
  blueskyClientIdFor,
  parseBlueskyClientKeys,
} from "./bluesky-client.ts";
import { linkedInClientFor } from "./linkedin-client.ts";
import { mastodonAppStore } from "./mastodon-apps.ts";
import { type Reach, reachOf } from "./reach.ts";
import { threadsAppFor } from "./threads-app.ts";

/** What the adapters are made with. */
export type ProviderContext = {
  env: Bindings;
  /** The app's own `fetch`. An adapter gets the one of its workspace. */
  fetch: Fetch;
  now: Clock;
  vault: Vault;
  /**
   * The keys that pigy signs with as a client of Bluesky, as configured,
   * or undefined if this pigy has none: `blueskyKeysFor` of
   * bluesky-client.ts for a request, `blueskyKeysWithoutRequest` for work
   * that no request stands behind.
   */
  blueskyClientKeys: string | undefined;
};

// What pigy is called on the consent page of a network.
const clientName = "pigy";

/**
 * The adapter of every network that pigy can connect, made with the reach
 * of a workspace. A network joins by getting an entry here.
 */
const adapters: {
  [Name in Network]?: (reach: Reach, context: ProviderContext) => Provider;
} = {
  bluesky: (reach, { now, blueskyClientKeys }) =>
    createBlueskyProvider({
      fetch: reach.fetch,
      now,
      clientIdFor: blueskyClientIdFor,
      // Read when they are needed: a post goes on without them, for as
      // long as its access is good.
      keys: async () =>
        blueskyClientKeys === undefined
          ? []
          : parseBlueskyClientKeys(blueskyClientKeys),
    }),
  linkedin: (reach, { env, now }) =>
    createLinkedInProvider({
      fetch: reach.fetch,
      now,
      // Without an application, nothing is connected: `cannotConnect`. A
      // channel from before goes on posting, which takes its token and
      // no application, and its access cannot be given back.
      ...(linkedInClientFor(reach, env) ?? { clientId: "", clientSecret: "" }),
    }),
  mastodon: (reach, { env, now, vault }) =>
    createMastodonProvider({
      fetch: reach.fetch,
      now,
      apps: mastodonAppStore(drizzle(env.DB), vault, reach.registrations, now),
      clientName,
    }),
  threads: (reach, { env, now }) =>
    createThreadsProvider({
      fetch: reach.fetch,
      now,
      // Without an app, nothing is connected: `cannotConnect`. A channel
      // from before goes on posting and renewing its access, which take
      // its token and no app.
      ...(threadsAppFor(reach, env) ?? { appId: "", appSecret: "" }),
    }),
};

/**
 * The adapter of `network` for `workspace`, with how the workspace reaches
 * the network, or undefined if pigy has no adapter for the network yet.
 * Every call of a provider in the Worker goes through here, so that
 * `reachOf` decides for all of them where their requests go.
 */
export function providerOf(
  network: Network,
  workspace: WorkspaceIdentity,
  context: ProviderContext,
): { provider: Provider; reach: Reach } | undefined {
  const adapter = adapters[network];
  if (!adapter) return undefined;
  const reach = reachOf(workspace, context.env, context.fetch);
  return { provider: adapter(reach, context), reach };
}

/**
 * Why this pigy cannot connect accounts of `network`, which has an
 * adapter, in a workspace with `reach`, or undefined if it can: a secret
 * that the network needs is not set. A network that needs one says so
 * here.
 */
export function cannotConnect(
  network: Network,
  reach: Reach,
  { env, blueskyClientKeys }: ProviderContext,
): string | undefined {
  if (network === "bluesky" && blueskyClientKeys === undefined) {
    return "This pigy is not set up to connect Bluesky accounts: it has no key to sign its requests with.";
  }
  // Only for real: a sandbox has an application of its own.
  if (network === "linkedin" && !linkedInClientFor(reach, env)) {
    return "This pigy is not set up to connect LinkedIn accounts: whoever runs it has not registered it with LinkedIn.";
  }
  if (network === "threads" && !threadsAppFor(reach, env)) {
    return "This pigy is not set up to connect Threads accounts: whoever runs it has not registered it with Meta.";
  }
  return undefined;
}
