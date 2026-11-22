import type { Clock, Fetch } from "@pigy/core";
import {
  type BlueskyClientKey,
  type BlueskyCredentials,
  createBlueskyProvider,
} from "../../src/bluesky/index.ts";
import type { Harness } from "./spec.ts";

/** What a live run is made with. */
type LiveOptions = {
  fetch: Fetch;
  now: Clock;
  /**
   * The client that the credentials were issued to: the address of its
   * metadata, which Bluesky reads, and its keys, which that holds.
   */
  clientId: string;
  keys: readonly BlueskyClientKey[];
  /** The handle of the account. */
  handle: string;
  credentials: BlueskyCredentials;
  /** Marks the posts of the run. */
  tag: string;
  sleep(seconds: number): Promise<void>;
};

/**
 * The harness of every test of a live run, which is given the credentials
 * of a session once: a function that makes the harness of the next test.
 *
 * A refresh replaces the refresh token, and the one it was given is
 * worthless afterwards: Bluesky ends the session when it comes again. So
 * the run keeps one copy of the credentials, renews it before each test,
 * because an access token lasts minutes, and takes what a test renews.
 */
export function blueskyLiveRun(options: LiveOptions): () => Promise<Harness> {
  let current = options.credentials;
  const provider = createBlueskyProvider({
    fetch: options.fetch,
    now: options.now,
    clientIdFor: () => options.clientId,
    keys: async () => options.keys,
  });
  return async () => {
    current = (await provider.refresh?.(current))
      ?.credentials as BlueskyCredentials;
    return {
      ...blueskyLiveHarness({ ...options, credentials: current }),
      renewed: (credentials) => {
        current = credentials as BlueskyCredentials;
      },
    };
  };
}

/**
 * The harness of a run against a Bluesky that cannot be looked into or
 * tampered with: the real one. It has the credentials of one account,
 * the client that they were issued to, and nothing else.
 *
 * Unlike Mastodon, Bluesky has no posts that only their author sees: what
 * the run posts is public until the test that made it deletes it, which is
 * at once.
 */
function blueskyLiveHarness(options: LiveOptions): Harness {
  const { fetch, now, clientId, keys, handle, credentials, tag, sleep } =
    options;
  // Of the form of tokens, and none that Bluesky has issued.
  const unknownToken = "pigy-conformance-run-not-a-token";
  return {
    provider: createBlueskyProvider({
      fetch,
      now,
      clientIdFor: () => clientId,
      keys: async () => keys,
    }),
    // The address that the client lists. Nothing is ever sent there: the
    // run cannot consent.
    redirectUri: new URL("/connect/bluesky/callback", clientId).href,
    identifier: handle,
    thread: "chain",
    // Until the adapter publishes images.
    noImages: true,
    counts: ["likes", "reposts", "replies", "quotes"],
    publicStats: true,
    credentials,
    refusedCredentials: {
      ...credentials,
      accessToken: unknownToken,
      refreshToken: unknownToken,
    },
    revokes: true,
    secrets: [
      credentials.accessToken,
      credentials.refreshToken,
      credentials.dpopKey.d,
      ...keys.map(({ privateKey }) => privateKey.d),
      unknownToken,
    ],
    tag,
    sleep,
    simulation: undefined,
  };
}
