import type { MastodonApp, MastodonAppStore } from "../src/mastodon/index.ts";

/**
 * Keeps the registrations with Mastodon instances in memory, where the
 * Worker keeps them in its database.
 */
export function memoryAppStore(): MastodonAppStore & {
  entries: Map<string, MastodonApp>;
} {
  const entries = new Map<string, MastodonApp>();
  return {
    entries,
    get: async (domain) => entries.get(domain),
    put: async (domain, app) => {
      entries.set(domain, app);
    },
  };
}
