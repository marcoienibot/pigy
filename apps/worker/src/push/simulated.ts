import type { Fetch } from "@pigy/core";

/**
 * A stand-in for the push services of the browsers that runs inside the
 * Worker, for the build that the end-to-end tests run against: that build
 * reaches no real host, and the browser of the tests has no push service.
 * src/simulated-push.ts makes one, and only src/index.ts imports that
 * file, under a condition that is false in every other build.
 */
export type SimulatedPush = {
  /** Answers on the hosts of the push services. */
  fetch: Fetch;
  /** Whether `host` is one of a push service. */
  owns(host: string): boolean;
  /**
   * Answers what a test asks of the simulated push services, at the path
   * that src/simulated-push.ts has: to make up a device, and what a device
   * has received. The path is not written out here: this file is part of
   * every build, and apps/web/scripts/check-build.mjs looks for that path
   * to tell that a build has the simulation.
   */
  handle(request: Request): Promise<Response>;
};
