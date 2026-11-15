import type { Clock, Fetch, Network } from "@pigy/core";
import type { Provider } from "@pigy/providers";
import { createMastodonProvider } from "@pigy/providers/mastodon";
import { drizzle } from "drizzle-orm/d1";
import type { Bindings } from "../env.ts";
import type { Vault } from "../vault.ts";
import type { WorkspaceIdentity } from "../workspace/store.ts";
import { mastodonAppStore } from "./mastodon-apps.ts";
import { type Reach, reachOf } from "./reach.ts";

/** What the adapters are made with. */
export type ProviderContext = {
  env: Bindings;
  /** The app's own `fetch`. An adapter gets the one of its workspace. */
  fetch: Fetch;
  now: Clock;
  vault: Vault;
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
  mastodon: (reach, { env, now, vault }) =>
    createMastodonProvider({
      fetch: reach.fetch,
      now,
      apps: mastodonAppStore(drizzle(env.DB), vault, reach.registrations, now),
      clientName,
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
