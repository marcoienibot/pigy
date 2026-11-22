import type { Clock, Fetch } from "@pigy/core";
import {
  createMastodonProvider,
  type MastodonCredentials,
} from "../../src/mastodon/index.ts";
import { memoryAppStore } from "../mastodon-apps.ts";
import type { Harness } from "./spec.ts";

// One registration per run, not one per test: an instance allows only a
// few in ten minutes.
const apps = memoryAppStore();

/**
 * The harness of a run against a Mastodon that cannot be looked into or
 * tampered with: a real one. It has the credentials of one account and
 * nothing else.
 *
 * What it posts is visible to the account alone. On Mastodon that is the
 * visibility "direct" without a mention.
 */
export function mastodonLiveHarness(options: {
  fetch: Fetch;
  now: Clock;
  credentials: MastodonCredentials;
  /** Marks the posts of the run. */
  tag: string;
  sleep(seconds: number): Promise<void>;
}): Harness {
  const { fetch, now, credentials, tag, sleep } = options;
  // Of the form of a token, and none that any instance has issued.
  const unknownToken = "pigy-conformance-run-not-a-token";
  return {
    provider: createMastodonProvider({
      fetch,
      now,
      apps,
      clientName: "pigy conformance run",
      visibility: "direct",
    }),
    // Nothing is ever sent here: the run cannot consent. A registration
    // needs an address all the same, and this one cannot exist.
    redirectUri: "https://pigy.invalid/connect/mastodon/callback",
    identifier: credentials.domain,
    thread: "chain",
    // And quotes, from Mastodon 4.5 on: the run does not know the version.
    counts: ["likes", "reposts", "replies"],
    credentials,
    refusedCredentials: { ...credentials, accessToken: unknownToken },
    revokes: true,
    secrets: [credentials.accessToken, credentials.clientSecret, unknownToken],
    tag,
    sleep,
    simulation: undefined,
  };
}
