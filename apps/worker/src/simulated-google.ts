import type { Clock } from "@pigy/core";
import {
  createGoogleSimulator,
  type GoogleSimulator,
  googleIssuer,
} from "@pigy/simulators/google";
import type { SimulatedGoogle } from "./auth/config.ts";

/**
 * Puts the simulated Google of @pigy/simulators in Google's place, for
 * development and tests. It signs anybody in as anybody, so it must never be
 * part of a production build: only src/index.ts imports this file, and only
 * under a condition that is false in production.
 */

// The simulated Google answers the Worker in-process, on Google's own
// addresses. A browser cannot reach it there, so its pages are served under
// this path of the app.
const browserPath = "/sim/google";

// The OAuth client that pigy is to the simulated Google. Not secrets.
const clientId = "pigy-simulated.apps.googleusercontent.com";
const clientSecret = "simulated-client-secret";

export function createSimulatedGoogle(now: Clock): SimulatedGoogle {
  // One per origin the app is reached at, because the redirect address that
  // is registered with the simulated Google contains the origin. They are
  // kept, so that each remembers which codes were redeemed. The accounts on
  // the consent page are the admins as of the first request.
  const simulators = new Map<string, GoogleSimulator>();
  const simulatorFor = (origin: string, adminEmails: Iterable<string>) => {
    let simulator = simulators.get(origin);
    if (!simulator) {
      simulator = createGoogleSimulator({
        now,
        client: {
          clientId,
          clientSecret,
          redirectUris: [`${origin}/api/auth/google/callback`],
        },
        accounts: [...adminEmails].map((email) => ({ email, name: "Admin" })),
      });
      simulators.set(origin, simulator);
    }
    return simulator;
  };

  return {
    defaultAdminEmails: "admin@example.com",

    connection: (origin, adminEmails) => ({
      clientId,
      clientSecret,
      fetch: simulatorFor(origin, adminEmails).fetch,
      browserUrl: (googleUrl) =>
        new URL(browserPath + googleUrl.pathname + googleUrl.search, origin),
    }),

    handle: (request, adminEmails) => {
      const url = new URL(request.url);
      // The reverse of `browserUrl`.
      const googleUrl = new URL(
        url.pathname.slice(browserPath.length) + url.search,
        googleIssuer,
      );
      return simulatorFor(url.origin, adminEmails).fetch(
        new Request(googleUrl, request),
      );
    },
  };
}
