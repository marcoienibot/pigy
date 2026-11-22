import type { Fetch } from "@pigy/core";
import { createLinkedInSimulator } from "@pigy/simulators/linkedin";
import { answerConsent, createWorld, feed } from "@pigy/simulators/world";
import {
  createLinkedInProvider,
  type LinkedInCredentials,
} from "../../src/linkedin/index.ts";
import { linkedInLiveHarness } from "./linkedin-live.ts";
import { describeProvider, shownIn } from "./spec.ts";

const redirectUri = "https://pigy.example/connect/linkedin/callback";

/** A new world with pigy as an application, one member and an adapter. */
function simulated() {
  const world = createWorld({ now: () => new Date("2026-11-15T10:00:00Z") });
  const simulator = createLinkedInSimulator(world);
  const client = simulator.addClient({
    name: "pigy",
    redirectUris: [redirectUri],
  });
  const ada = simulator.addMember("Ada Lovelace");
  // Counts the requests that ask LinkedIn to publish a post.
  let publishRequests = 0;
  const fetch: Fetch = (input, init) => {
    const request = new Request(input, init);
    if (request.method === "POST" && request.url.endsWith("/rest/posts")) {
      publishRequests++;
    }
    return simulator.fetch(request);
  };
  const provider = createLinkedInProvider({
    fetch,
    now: world.now,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
  });
  const consent = async (url: string, answer: "allow" | "deny") =>
    (
      await answerConsent(
        simulator.fetch,
        url,
        answer === "allow" ? { account: ada.id } : "deny",
      )
    ).searchParams;
  /** Connects the test member the way a person connects an account. */
  const connect = async () => {
    const start = await provider.beginConnect({ redirectUri });
    const { access } = await provider.completeConnect({
      pending: start.pending,
      params: await consent(start.url, "allow"),
    });
    return access.credentials as LinkedInCredentials;
  };
  return {
    world,
    simulator,
    client,
    provider,
    consent,
    connect,
    publishRequests: () => publishRequests,
  };
}

// The LinkedIn adapter against the simulated LinkedIn, in a new world for
// every test.
describeProvider("LinkedIn, simulated", async () => {
  const {
    world,
    simulator,
    client,
    provider,
    consent,
    connect,
    publishRequests,
  } = simulated();
  const credentials = await connect();
  // A token as the real LinkedIn makes them, which the simulation must
  // refuse.
  const unknownToken = "AQXdSP_W41_UPs5ioT_t8HESyODB4FqbkJ8LrV_5mff4gPODzOYR";

  return {
    provider,
    redirectUri,
    identifier: undefined,
    thread: "joined",
    // LinkedIn gives pigy no stats of the posts of a member.
    counts: [],
    credentials,
    refusedCredentials: { ...credentials, accessToken: unknownToken },
    revokes: true,
    secrets: [credentials.accessToken, client.clientSecret, unknownToken],
    tag: "pigy conformance",
    sleep: async (seconds) => world.advance(seconds * 1000),
    simulation: {
      consent,
      arm: (kind, during = "publish") => {
        // An access to LinkedIn is not renewed, so the specification does
        // not ask for this of a provider that has no refresh.
        if (kind === "token-expired") {
          throw new Error("A token of LinkedIn is not renewed");
        }
        simulator.arm({
          kind,
          // With the code exchanged for a token, the adapter asks whose
          // token it is.
          operation:
            during === "connect"
              ? "account"
              : during === "upload"
                ? "upload"
                : "publish",
        });
      },
      engage: (id, more) => world.engage("linkedin", id, more),
      published: () => feed(world, ["linkedin"]).map(({ post }) => post.text),
      shown: () => shownIn(world, "linkedin"),
      mention: "@ada",
      publishRequests,
      now: world.now,
      advance: world.advance,
    },
  };
});

// The same, with the harness of a live run: what test/live/linkedin.live.ts
// runs against the real LinkedIn, here with the simulated one behind it. A
// live run cannot be part of CI, so this is what keeps its harness, and
// the specification without a simulation to lean on, from breaking
// unnoticed.
describeProvider(
  "LinkedIn, simulated, with the harness of a live run",
  async () => {
    const { world, simulator, client, connect } = simulated();
    return linkedInLiveHarness({
      fetch: simulator.fetch,
      now: world.now,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      credentials: await connect(),
      tag: "pigy conformance",
      sleep: async (seconds) => world.advance(seconds * 1000),
    });
  },
);
