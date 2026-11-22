import type { Clock, Fetch } from "@pigy/core";
import {
  createThreadsProvider,
  type ThreadsCredentials,
} from "../../src/threads/index.ts";
import type { Harness } from "./spec.ts";

/**
 * The harness of a run against a Threads that cannot be looked into or
 * tampered with: the real one. It has the app of whoever runs it, the
 * credentials of one account, and nothing else.
 *
 * Threads has no posts that only their author sees. What the run posts is
 * public until the test that made it deletes it.
 */
export function threadsLiveHarness(options: {
  fetch: Fetch;
  now: Clock;
  appId: string;
  appSecret: string;
  credentials: ThreadsCredentials;
  /** Marks the posts of the run. */
  tag: string;
  sleep(seconds: number): Promise<void>;
}): Harness {
  const { fetch, now, appId, appSecret, credentials, tag, sleep } = options;
  // Of the form of a token, and none that Threads has issued.
  const unknownToken = "pigy-conformance-run-not-a-token";
  return {
    provider: createThreadsProvider({ fetch, now, appId, appSecret }),
    // Nothing is ever sent here: the run cannot consent.
    redirectUri: "https://pigy.invalid/connect/threads/callback",
    identifier: undefined,
    thread: "chain",
    // Until the adapter publishes images.
    noImages: true,
    counts: ["likes", "reposts", "replies", "quotes", "views"],
    credentials,
    refusedCredentials: { ...credentials, accessToken: unknownToken },
    revokes: false,
    refreshOnlyByTimer: true,
    secrets: [credentials.accessToken, appSecret, unknownToken],
    tag,
    sleep,
    simulation: undefined,
  };
}
