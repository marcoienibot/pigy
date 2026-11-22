import type { Fetch } from "@pigy/core";
import { createThreadsSimulator } from "@pigy/simulators/threads";
import { answerConsent, createWorld, feed } from "@pigy/simulators/world";
import {
  createThreadsProvider,
  type ThreadsCredentials,
} from "../../src/threads/index.ts";
import { describeProvider, shownIn } from "./spec.ts";
import { threadsLiveHarness } from "./threads-live.ts";

const redirectUri = "https://pigy.example/connect/threads/callback";

/** A new world with pigy as an app, one account and an adapter. */
function simulated() {
  const world = createWorld({ now: () => new Date("2026-11-15T10:00:00Z") });
  const simulator = createThreadsSimulator(world);
  const app = simulator.addApp({ name: "pigy", redirectUris: [redirectUri] });
  const ada = simulator.addUser({ username: "ada", name: "Ada Lovelace" });
  // Counts the requests that ask Threads to publish a container. Making
  // one publishes nothing, and is not among them.
  let publishRequests = 0;
  const fetch: Fetch = (input, init) => {
    const request = new Request(input, init);
    if (
      request.method === "POST" &&
      new URL(request.url).pathname.endsWith("/threads_publish")
    ) {
      publishRequests++;
    }
    return simulator.fetch(request);
  };
  const provider = createThreadsProvider({
    fetch,
    now: world.now,
    appId: app.appId,
    appSecret: app.appSecret,
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
    const start = await provider.beginConnect({ redirectUri });
    const { access } = await provider.completeConnect({
      pending: start.pending,
      params: await consent(start.url, "allow"),
    });
    return access.credentials as ThreadsCredentials;
  };
  return {
    world,
    simulator,
    app,
    provider,
    consent,
    connect,
    publishRequests: () => publishRequests,
  };
}

// The Threads adapter against the simulated Threads, in a new world for
// every test.
describeProvider("Threads, simulated", async () => {
  const { world, simulator, app, provider, consent, connect, publishRequests } =
    simulated();
  const credentials = await connect();
  // A token as the real Threads makes them, which the simulation must
  // refuse.
  const unknownToken = "THQVJabcdefghijklmnopqrstuvwxyz0123456789ZD";

  return {
    provider,
    redirectUri,
    identifier: undefined,
    thread: "chain",
    // Until the adapter publishes images.
    noImages: true,
    counts: ["likes", "reposts", "replies", "quotes", "views"],
    credentials,
    refusedCredentials: { ...credentials, accessToken: unknownToken },
    // Threads has no way for an app to give an access back.
    revokes: false,
    // And it renews no token that it refuses.
    refreshOnlyByTimer: true,
    secrets: [credentials.accessToken, app.appSecret, unknownToken],
    tag: "pigy conformance",
    sleep: async (seconds) => world.advance(seconds * 1000),
    simulation: {
      consent,
      arm: (kind, during = "publish") => {
        // A token of Threads that has ended is not renewed, so the
        // specification does not ask for this of its provider.
        if (kind === "token-expired") {
          throw new Error("A token of Threads that has ended is not renewed");
        }
        simulator.arm({
          kind,
          // With the code exchanged for a token of an hour, the adapter
          // asks for the one that lasts.
          operation: {
            connect: "exchange",
            publish: "publish",
            stats: "stats",
          }[during] as "exchange" | "publish" | "stats",
        });
      },
      engage: (id, more) => world.engage("threads", id, more),
      published: () => feed(world, ["threads"]).map(({ post }) => post.text),
      shown: () => shownIn(world, "threads"),
      mention: "@ada",
      publishRequests,
      now: world.now,
      advance: world.advance,
    },
  };
});

// The same, with the harness of a live run: what test/live/threads.live.ts
// runs against the real Threads, here with the simulated one behind it. A
// live run cannot be part of CI, so this is what keeps its harness, and
// the specification without a simulation to lean on, from breaking
// unnoticed.
describeProvider(
  "Threads, simulated, with the harness of a live run",
  async () => {
    const { world, simulator, app, connect } = simulated();
    return threadsLiveHarness({
      fetch: simulator.fetch,
      now: world.now,
      appId: app.appId,
      appSecret: app.appSecret,
      credentials: await connect(),
      tag: "pigy conformance",
      sleep: async (seconds) => world.advance(seconds * 1000),
    });
  },
);
