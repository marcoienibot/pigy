import type { Fetch } from "@pigy/core";
import type { providerOf } from "../src/network/providers.ts";

/**
 * The clock of the test that is running. `setup()` in helpers.ts sets it,
 * and gives it to the app it builds. The workspace objects read it too:
 * the runtime constructs them from the class in main.ts, which a test cannot
 * hand anything to, so what they share with the test is this module.
 */
export const clock = {
  time: new Date(0),
  /** How far Google's clock is behind the app's. */
  googleLagMs: 0,
};

/**
 * What the app of the test that is running was built and deployed with, for
 * the publishing workflow: the runtime constructs it from the class in
 * main.ts, like the workspace objects. `setup()` in helpers.ts sets it.
 */
export const deployment: {
  /** The `fetch` that leads to what stands for the real networks. */
  fetch: Fetch;
  /** The secrets of the deployment, as `setup()` and `redeploy` give them. */
  secrets: Record<string, string>;
  /**
   * Stands between the workflow and the adapters, for a test to put
   * another adapter in the place of one. Undefined leaves them as they are.
   */
  providerOf: typeof providerOf | undefined;
  /**
   * The pauses that the workflow has asked for within its steps, in
   * milliseconds and in their order. None of them takes any time in a test.
   */
  pauses: number[];
} = {
  fetch: async () => {
    throw new Error("No test has set up a deployment");
  },
  secrets: {},
  providerOf: undefined,
  pauses: [],
};
