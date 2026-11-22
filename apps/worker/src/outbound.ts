import type { Fetch } from "@pigy/core";
import type { SimulatedPush } from "./push/simulated.ts";

/**
 * The `fetch` that the app reaches the outside with, by the mode that the
 * Worker was built in: the networks of the live workspaces, and Google.
 * src/index.ts passes it the mode, and nothing else chooses.
 *
 * The build that the end-to-end tests run against must never reach a real
 * host, like everything under test. Its sign-in is simulated and its
 * sandboxes are answered by their simulated worlds, both inside the Worker,
 * so what is left to stop is a live workspace: there, every request is
 * answered here, and none leaves. A push message, which goes to a push
 * service whichever workspace it is about, is handed to the simulated push
 * service of that build. Every other build uses the runtime's own
 * `fetch`: `pnpm dev` connects real accounts.
 */
export function outboundFetch(
  mode: string,
  simulatedPush?: Pick<SimulatedPush, "fetch" | "owns">,
): Fetch {
  if (mode !== "e2e") return runtimeFetch;
  // The one thing that the app sends for a workspace of either kind is a
  // push message, to the device of a person. In this build the push
  // services are simulated too, and answer here.
  return (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    return simulatedPush?.owns(new URL(url).host)
      ? simulatedPush.fetch(input, init)
      : refuseOutbound(input, init);
  };
}

/**
 * The runtime's own `fetch`, failing the way the Fetch standard has it when
 * no answer comes: with a TypeError. That is what an adapter takes for a
 * network that is out of reach, and nothing else. The Workers runtime fails
 * with a plain error instead, such as "Network connection lost.", which an
 * adapter could not tell from a bug in whatever it was given as `fetch`.
 */
const runtimeFetch: Fetch = async (input, init) => {
  try {
    return await fetch(input, init);
  } catch (error) {
    // A request that its own signal has ended fails with what the signal
    // says, which is for whoever set the signal to read.
    if (error instanceof TypeError || init?.signal?.aborted) throw error;
    throw new TypeError(
      error instanceof Error ? error.message : String(error),
      {
        cause: error,
      },
    );
  }
};

/**
 * Answers in place of the host, the way a gateway does that cannot reach
 * it. An answer rather than a failure, so that a test can tell a request
 * that was stopped here from one that left and found nobody.
 */
const refuseOutbound: Fetch = async (input) => {
  const url = input instanceof Request ? input.url : String(input);
  return new Response(`Blocked outbound request to ${url}`, { status: 502 });
};
