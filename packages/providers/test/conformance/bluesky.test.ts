import type { Fetch } from "@pigy/core";
import { createBlueskySimulator } from "@pigy/simulators/bluesky";
import { answerConsent, createWorld, feed } from "@pigy/simulators/world";
import {
  type BlueskyClientKey,
  type BlueskyCredentials,
  clientMetadata,
  createBlueskyProvider,
} from "../../src/bluesky/index.ts";
import { newClientKey } from "../bluesky-keys.ts";
import { blueskyLiveHarness } from "./bluesky-live.ts";
import { describeProvider } from "./spec.ts";

const origin = "https://pigy.example";
const redirectUri = `${origin}/connect/bluesky/callback`;
const clientId = `${origin}/connect/bluesky/client-metadata.json`;
const pds = "pds.bsky.test";
const handle = "ada.bsky.test";

/**
 * A new world with Bluesky's entryway, one PDS behind it and one account
 * there, and an adapter with a key of its own. The world finds pigy's
 * client metadata at its address: what pigy would serve there.
 */
async function simulated() {
  const world = createWorld({ now: () => new Date("2026-11-15T10:00:00Z") });
  const key = await newClientKey("key-1");
  const keys: BlueskyClientKey[] = [key];
  const metadata = clientMetadata({
    clientId,
    redirectUri,
    name: "pigy",
    keys,
  });
  const simulator = createBlueskySimulator(world, {
    clients: (id) => (id === clientId ? metadata : undefined),
  });
  simulator.addPds(pds);
  const ada = simulator.addAccount({ handle, pds, name: "Ada Lovelace" });
  // Counts the requests that ask the PDS to write a post, and that it took
  // up. A request that it refused for its proof, which a client learns the
  // nonce of the PDS from, or for its token, has written nothing and
  // asked nothing of the repository.
  let publishRequests = 0;
  const fetch: Fetch = async (input, init) => {
    const request = new Request(input, init);
    const response = await simulator.fetch(request);
    if (
      request.method === "POST" &&
      request.url.endsWith("/xrpc/com.atproto.repo.createRecord") &&
      response.status !== 401
    ) {
      publishRequests++;
    }
    return response;
  };
  const provider = createBlueskyProvider({
    fetch,
    now: world.now,
    clientIdFor: () => clientId,
    keys: async () => keys,
  });
  const consent = async (url: string, answer: "allow" | "deny") =>
    (
      await answerConsent(
        simulator.fetch,
        url,
        answer === "allow" ? { account: ada.id } : "deny",
      )
    ).searchParams;
  /** Connects the test account the way a person connects one. */
  const connect = async () => {
    const start = await provider.beginConnect({
      redirectUri,
      identifier: handle,
    });
    const { access } = await provider.completeConnect({
      pending: start.pending,
      params: await consent(start.url, "allow"),
    });
    return access.credentials as BlueskyCredentials;
  };
  return {
    world,
    simulator,
    provider,
    key,
    consent,
    connect,
    publishRequests: () => publishRequests,
  };
}

// The Bluesky adapter against the simulated Bluesky, in a new world for
// every test.
describeProvider("Bluesky, simulated", async () => {
  const { world, simulator, provider, key, consent, connect, publishRequests } =
    await simulated();
  const credentials = await connect();
  // Tokens as Bluesky makes them, which the simulation must refuse: the
  // access token is a JWT, the refresh token a random string.
  const unknownAccess =
    "eyJ0eXAiOiJhdCtqd3QiLCJhbGciOiJFUzI1NksifQ.eyJzY29wZSI6ImF0cHJvdG8ifQ.c2lnbmF0dXJl";
  const unknownRefresh = "ref-2b6c0d3e8f1a4c5b9d7e6f0a1b2c3d4e";

  return {
    provider,
    redirectUri,
    identifier: handle,
    thread: "chain",
    credentials,
    refusedCredentials: {
      ...credentials,
      accessToken: unknownAccess,
      refreshToken: unknownRefresh,
    },
    revokes: true,
    secrets: [
      credentials.accessToken,
      credentials.refreshToken,
      credentials.dpopKey.d,
      key.privateKey.d,
      unknownAccess,
      unknownRefresh,
    ],
    tag: "pigy conformance",
    sleep: async (seconds) => world.advance(seconds * 1000),
    simulation: {
      consent,
      arm: (kind, during = "publish") =>
        simulator.arm({
          kind,
          // With the code exchanged for tokens, the adapter reads the
          // profile of the account.
          operation: during === "connect" ? "profile" : "publish",
        }),
      published: () => feed(world, ["bluesky"]).map(({ post }) => post.text),
      publishRequests,
      now: world.now,
      advance: world.advance,
    },
  };
});

// The same, with the harness of a live run: what test/live/bluesky.live.ts
// runs against Bluesky, here with the simulated one behind it. A live run
// cannot be part of CI, so this is what keeps its harness, and the
// specification without a simulation to lean on, from breaking unnoticed.
describeProvider(
  "Bluesky, simulated, with the harness of a live run",
  async () => {
    const { world, simulator, key, connect } = await simulated();
    return blueskyLiveHarness({
      fetch: simulator.fetch,
      now: world.now,
      clientId,
      keys: [key],
      handle,
      credentials: await connect(),
      tag: "pigy conformance",
      sleep: async (seconds) => world.advance(seconds * 1000),
    });
  },
);
