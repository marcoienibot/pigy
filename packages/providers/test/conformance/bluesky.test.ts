import type { Fetch } from "@pigy/core";
import { createBlueskySimulator } from "@pigy/simulators/bluesky";
import { answerConsent, createWorld, feed } from "@pigy/simulators/world";
import { describe, expect, it } from "vitest";
import {
  type BlueskyClientKey,
  type BlueskyCredentials,
  clientMetadata,
  createBlueskyProvider,
} from "../../src/bluesky/index.ts";
import { newClientKey } from "../bluesky-keys.ts";
import { blueskyLiveRun } from "./bluesky-live.ts";
import {
  accessOf,
  describeProvider,
  type Simulation,
  shownIn,
} from "./spec.ts";

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
  // The fault that strikes the next exchange of a code for tokens once the
  // server has taken the code. Nothing that a connection asks for after
  // the exchange can fail it, so this is where a network fails "once it
  // has taken the code of the callback", as `Simulation.arm` has it: the
  // server has issued the tokens, and pigy gets the fault in their place.
  let duringConnect: Parameters<Simulation["arm"]>[0] | undefined;
  const fetch: Fetch = async (input, init) => {
    const request = new Request(input, init);
    const exchange =
      duringConnect !== undefined &&
      request.url.endsWith("/oauth/token") &&
      new URLSearchParams(await request.clone().text()).get("grant_type") ===
        "authorization_code";
    const response = await simulator.fetch(request);
    if (exchange && response.status === 200) {
      const kind = duringConnect;
      duringConnect = undefined;
      switch (kind) {
        case "server-error":
          // What the proxy in front of the server answers.
          return new Response("<html><title>502 Bad Gateway</title></html>", {
            status: 502,
            headers: { "Content-Type": "text/html" },
          });
        case "lost-response":
          throw new TypeError("The answer was lost on the way back");
        default:
          throw new Error(`No fault "${kind}" while connecting to Bluesky`);
      }
    }
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
    armDuringConnect: (kind: Parameters<Simulation["arm"]>[0]) => {
      duringConnect = kind;
    },
  };
}

// The Bluesky adapter against the simulated Bluesky, in a new world for
// every test.
describeProvider("Bluesky, simulated", async () => {
  const {
    world,
    simulator,
    provider,
    key,
    consent,
    connect,
    publishRequests,
    armDuringConnect,
  } = await simulated();
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
    counts: ["likes", "reposts", "replies", "quotes"],
    publicStats: true,
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
        during === "connect"
          ? armDuringConnect(kind)
          : simulator.arm({ kind, operation: during }),
      engage: (id, more) => world.engage("bluesky", id, more),
      published: () => feed(world, ["bluesky"]).map(({ post }) => post.text),
      shown: () => shownIn(world, "bluesky"),
      mention: `@${handle}`,
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
    return blueskyLiveRun({
      fetch: simulator.fetch,
      now: world.now,
      clientId,
      keys: [key],
      handle,
      credentials: await connect(),
      tag: "pigy conformance",
      sleep: async (seconds) => world.advance(seconds * 1000),
    })();
  },
);

describe("the harness of a live run", () => {
  it("begins each test with the credentials that the tests before it renewed", async () => {
    const { world, simulator, key, connect } = await simulated();
    const setup = blueskyLiveRun({
      fetch: simulator.fetch,
      now: world.now,
      clientId,
      keys: [key],
      handle,
      credentials: await connect(),
      tag: "pigy conformance",
      sleep: async (seconds) => world.advance(seconds * 1000),
    });
    const first = await setup();
    // A test renews the access, as the specification does when Bluesky
    // refuses the access token in the middle of a test, which a live run
    // meets when a test takes longer than an access token lasts.
    const source = accessOf(first);
    await source.refresh(await source.credentials());
    // The next test renews what that refresh returned. A refresh of the
    // credentials from before it would end the session, with Bluesky as
    // in the simulation.
    const second = await setup();
    const progress = await second.provider.publishStep({
      credentials: second.credentials,
      content: { parts: [{ text: "pigy conformance" }] },
      key: "next",
      progress: await second.provider.publishStep({
        credentials: second.credentials,
        content: { parts: [{ text: "pigy conformance" }] },
        key: "next",
        progress: null,
      }),
    });
    expect(progress.done).toBe(true);
    expect(feed(world, ["bluesky"]).map(({ post }) => post.text)).toEqual([
      "pigy conformance",
    ]);
  });
});
