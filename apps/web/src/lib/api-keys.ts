import type { ApiKey, ApiScope, Environment } from "@pigy/core";
import { dayOf, whenAgo } from "@/lib/time";

/**
 * What the API screen of the settings says of the keys of the public API.
 */

/** What each scope that a key can be given lets it do, in words. */
export const scopeLabels: {
  readonly [Scope in Exclude<ApiScope, "media:write">]: string;
} = {
  "posts:read": "Read posts and the posting schedule",
  "posts:write": "Create, change and delete posts, and set the schedule",
  "channels:read": "Read the connected accounts",
};

const day = 24 * 60 * 60 * 1000;

/** For how long a new key can be made to work, in days. Null is for good. */
export const lifetimes: readonly { label: string; days: number | null }[] = [
  { label: "Never expires", days: null },
  { label: "Expires in 30 days", days: 30 },
  { label: "Expires in 90 days", days: 90 },
  { label: "Expires in a year", days: 365 },
];

/** When a key that is made at `now` to last `days` stops working. */
export const expiryOf = (days: number | null, now: number): number | null =>
  days === null ? null : now + days * day;

/** What a workspace is called where its keys are talked about. */
export const workspaceWords: { readonly [E in Environment]: string } = {
  live: "live workspace",
  sandbox: "sandbox",
};

/** What a key of an environment does, in a sentence. */
export const reachOf: { readonly [E in Environment]: string } = {
  live: "A key of the live workspace posts to your real accounts.",
  sandbox:
    "A key of the sandbox posts to the simulated networks only: nothing that a script does with it reaches a real account.",
};

/** The line under the name of a key: when it was made, used and ends. */
export function keyNotes(key: ApiKey, now: number): string {
  return [
    `Created ${whenAgo(key.createdAt, now)}`,
    key.lastUsedAt === null
      ? "Never used"
      : `Last used ${whenAgo(key.lastUsedAt, now)}`,
    key.expiresAt === null
      ? "Never expires"
      : key.expiresAt <= now
        ? `Expired on ${dayOf(key.expiresAt, now)}`
        : `Expires on ${dayOf(key.expiresAt, now)}`,
  ].join(" · ");
}
