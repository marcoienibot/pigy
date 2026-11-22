import type { Clock, Fetch } from "@pigy/core";
import {
  createLinkedInProvider,
  type LinkedInCredentials,
} from "../../src/linkedin/index.ts";
import type { Harness } from "./spec.ts";

/**
 * The harness of a run against a LinkedIn that cannot be looked into or
 * tampered with: the real one. It has the application of whoever runs it,
 * the credentials of one member, and nothing else.
 *
 * LinkedIn has no posts that only their author sees. What the run posts
 * is for the connections of the member, the least that there is, until
 * the test that made it deletes it.
 */
export function linkedInLiveHarness(options: {
  fetch: Fetch;
  now: Clock;
  clientId: string;
  clientSecret: string;
  credentials: LinkedInCredentials;
  /** Marks the posts of the run. */
  tag: string;
  sleep(seconds: number): Promise<void>;
}): Harness {
  const { fetch, now, clientId, clientSecret, credentials, tag, sleep } =
    options;
  // Of the form of a token, and none that LinkedIn has issued.
  const unknownToken = "pigy-conformance-run-not-a-token";
  return {
    provider: createLinkedInProvider({
      fetch,
      now,
      clientId,
      clientSecret,
      visibility: "CONNECTIONS",
    }),
    // Nothing is ever sent here: the run cannot consent.
    redirectUri: "https://pigy.invalid/connect/linkedin/callback",
    identifier: undefined,
    thread: "joined",
    // Until the adapter publishes images.
    noImages: true,
    credentials,
    refusedCredentials: { ...credentials, accessToken: unknownToken },
    revokes: true,
    secrets: [credentials.accessToken, clientSecret, unknownToken],
    tag,
    sleep,
    simulation: undefined,
  };
}
