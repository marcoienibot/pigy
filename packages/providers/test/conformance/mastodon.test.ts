import type { Fetch } from "@pigy/core";
import { createMastodonSimulator } from "@pigy/simulators/mastodon";
import { answerConsent, createWorld, feed } from "@pigy/simulators/world";
import {
  createMastodonProvider,
  type MastodonCredentials,
} from "../../src/mastodon/index.ts";
import { memoryAppStore } from "../mastodon-apps.ts";
import { mastodonLiveHarness } from "./mastodon-live.ts";
import { describeProvider, shownIn } from "./spec.ts";

const domain = "mastodon.example";
const redirectUri = "https://pigy.example/connect/mastodon/callback";

/** A new world with one instance, one account on it and an adapter. */
function simulated() {
  const world = createWorld({ now: () => new Date("2026-11-15T10:00:00Z") });
  const simulator = createMastodonSimulator(world);
  simulator.addInstance(domain);
  const ada = simulator.addAccount(domain, "ada", "Ada Lovelace");
  // Counts the requests that ask Mastodon to post a status.
  let publishRequests = 0;
  const fetch: Fetch = (input, init) => {
    const request = new Request(input, init);
    if (request.method === "POST" && request.url.endsWith("/api/v1/statuses")) {
      publishRequests++;
    }
    return simulator.fetch(request);
  };
  const provider = createMastodonProvider({
    fetch,
    now: world.now,
    apps: memoryAppStore(),
    clientName: "pigy",
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
      identifier: domain,
    });
    const { access } = await provider.completeConnect({
      pending: start.pending,
      params: await consent(start.url, "allow"),
    });
    return access.credentials as MastodonCredentials;
  };
  return {
    world,
    simulator,
    provider,
    consent,
    connect,
    publishRequests: () => publishRequests,
  };
}

// The Mastodon adapter against the simulated Mastodon, in a new world for
// every test.
describeProvider("Mastodon, simulated", async () => {
  const { world, simulator, provider, consent, connect, publishRequests } =
    simulated();
  const credentials = await connect();
  // A token as a real Mastodon makes them, which the simulation must refuse.
  const unknownToken = "ZA-Yj3aBD8U8Cm7lKUp-lm9O9BmDgdhHzDeqsY8tlL0";

  return {
    provider,
    redirectUri,
    identifier: domain,
    thread: "chain",
    counts: ["likes", "reposts", "replies", "quotes"],
    credentials,
    refusedCredentials: { ...credentials, accessToken: unknownToken },
    revokes: true,
    secrets: [credentials.accessToken, credentials.clientSecret, unknownToken],
    tag: "pigy conformance",
    sleep: async (seconds) => world.advance(seconds * 1000),
    simulation: {
      consent,
      arm: (kind, during = "publish") => {
        // An access to Mastodon does not end, so the specification does
        // not ask for this of a provider that has no refresh.
        if (kind === "token-expired") {
          throw new Error("A token of Mastodon does not expire");
        }
        simulator.arm({
          kind,
          // With the code exchanged for a token, the adapter asks whose
          // token it is.
          // The counts of a status are in the status.
          operation: { connect: "account", publish: "publish", stats: "read" }[
            during
          ] as "account" | "publish" | "read",
        });
      },
      engage: (id, more) => world.engage("mastodon", id, more),
      published: () => feed(world, ["mastodon"]).map(({ post }) => post.text),
      shown: () => shownIn(world, "mastodon"),
      mention: "@ada",
      publishRequests,
      now: world.now,
      advance: world.advance,
    },
  };
});

// The same, with the harness of a live run: what test/live/mastodon.live.ts
// runs against a real server, here with the simulated one behind it. A live
// run cannot be part of CI, so this is what keeps its harness, and the
// specification without a simulation to lean on, from breaking unnoticed.
describeProvider(
  "Mastodon, simulated, with the harness of a live run",
  async () => {
    const { world, simulator, connect } = simulated();
    return mastodonLiveHarness({
      fetch: simulator.fetch,
      now: world.now,
      credentials: await connect(),
      tag: "pigy conformance",
      sleep: async (seconds) => world.advance(seconds * 1000),
    });
  },
);
