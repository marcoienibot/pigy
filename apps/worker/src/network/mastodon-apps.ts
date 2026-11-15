import type { Clock } from "@pigy/core";
import type { MastodonAppStore } from "@pigy/providers/mastodon";
import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { mastodonApps } from "../db/schema.ts";
import type { Vault } from "../vault.ts";

/**
 * Where the Mastodon adapter keeps pigy's registrations with instances: the
 * table `mastodon_app` of D1, under `scope`. A registration holds a client
 * secret, so it is sealed.
 */
export function mastodonAppStore(
  db: DrizzleD1Database,
  vault: Vault,
  scope: string,
  now: Clock,
): MastodonAppStore {
  const context = (domain: string) => ["mastodon_app", scope, domain];
  return {
    async get(domain) {
      const [stored] = await db
        .select({ registration: mastodonApps.registration })
        .from(mastodonApps)
        .where(
          and(eq(mastodonApps.scope, scope), eq(mastodonApps.domain, domain)),
        );
      if (!stored) return undefined;
      // The store is a cache. An entry that does not open, because its key
      // is gone, is as good as none: the adapter registers again.
      return vault
        .open(context(domain), stored.registration)
        .catch(() => undefined);
    },
    async put(domain, app) {
      const registration = await vault.seal(context(domain), app);
      const updatedAt = now();
      await db
        .insert(mastodonApps)
        .values({ scope, domain, registration, updatedAt })
        .onConflictDoUpdate({
          target: [mastodonApps.scope, mastodonApps.domain],
          set: { registration, updatedAt },
        });
    },
  };
}
