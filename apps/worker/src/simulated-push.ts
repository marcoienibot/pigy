import type { Clock } from "@pigy/core";
import { createPushSimulator } from "@pigy/simulators/push";
import { z } from "zod";
import type { SimulatedPush } from "./push/simulated.ts";

/**
 * Puts the simulated push service of @pigy/simulators in the place of the
 * push services of the browsers, for the build that the end-to-end tests
 * run against. It must never be part of a production build: only
 * src/index.ts imports this file, and only under a condition that is false
 * in every other build. apps/web/scripts/check-build.mjs fails a
 * production build that contains it.
 *
 * The devices and what they received are kept in memory, like the codes of
 * the simulated Google: they last as long as the Worker does, which is
 * longer than a test.
 */

/** Where a test reaches the simulated push services. */
const path = "/api/e2e/push";

export function createSimulatedPush(now: Clock): SimulatedPush {
  const simulator = createPushSimulator({ now });
  // Made here and not next to the function: what a module does when it is
  // loaded, a bundler keeps, and a production build would then hold a part
  // of this file.
  const subscribeSchema = z.strictObject({
    applicationServerKey: z.string().min(1).max(200),
  });
  const endpointSchema = z.strictObject({
    endpoint: z.string().min(1).max(2000),
  });

  const routes: Record<string, (body: unknown) => Promise<unknown> | unknown> =
    {
      // What `pushManager.subscribe` hands a page, for a device that the
      // simulated push service makes up and holds the keys of.
      [`${path}/devices`]: (body) =>
        simulator.subscribe(subscribeSchema.parse(body)),
      // What that device has received, decrypted as its browser would.
      [`${path}/received`]: (body) => ({
        messages: simulator.received(endpointSchema.parse(body).endpoint),
      }),
      // The push service drops the device: the next message is answered
      // with 410.
      [`${path}/gone`]: (body) => {
        simulator.unsubscribe(endpointSchema.parse(body).endpoint);
        return {};
      },
    };

  return {
    fetch: simulator.fetch,
    owns: simulator.owns,
    async handle(request) {
      const route = routes[new URL(request.url).pathname];
      if (!route || request.method !== "POST") {
        return Response.json(
          { error: "NotFoundError", message: "Not found" },
          { status: 404 },
        );
      }
      try {
        return Response.json(await route(await request.json()));
      } catch (error) {
        return Response.json(
          {
            error: "InvalidInputError",
            message: error instanceof Error ? error.message : "Invalid request",
          },
          { status: 400 },
        );
      }
    },
  };
}
