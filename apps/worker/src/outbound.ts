import type { Fetch } from "@pigy/core";

/**
 * The `fetch` that the app reaches the outside with, by the mode that the
 * Worker was built in: the networks of the live workspaces, and Google.
 * src/index.ts passes it the mode, and nothing else chooses.
 *
 * The build that the end-to-end tests run against must never reach a real
 * host, like everything under test. Its sign-in is simulated and its
 * sandboxes are answered by their simulated worlds, both inside the Worker,
 * so what is left to stop is a live workspace: there, every request is
 * answered here, and none leaves. Every other build uses the runtime's own
 * `fetch`: `pnpm dev` connects real accounts.
 */
export function outboundFetch(mode: string): Fetch {
  return mode === "e2e" ? refuseOutbound : runtimeFetch;
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
