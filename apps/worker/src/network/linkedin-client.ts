import type { Bindings } from "../env.ts";
import type { Reach } from "./reach.ts";
import { registrationFor } from "./registration.ts";

/**
 * pigy as an application of LinkedIn's. Unlike Mastodon, where pigy
 * registers itself with each server, and Bluesky, where it describes
 * itself at an address, LinkedIn knows an application only as whoever
 * runs it has made it in LinkedIn's developer portal: with the products
 * "Share on LinkedIn" and "Sign In with LinkedIn using OpenID Connect",
 * and with the callback address of this pigy. Its ID and its secret are
 * the secrets `LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET`.
 */

/** An application of LinkedIn's: what its developer portal hands out. */
export type LinkedInClient = { clientId: string; clientSecret: string };

/**
 * The application that pigy is in the simulated LinkedIn of every sandbox,
 * which the world of a sandbox is made with: src/sim/object.ts.
 *
 * It is here for everybody to read, and that is fine: it is good in a
 * simulated world and nowhere else, as `registrationFor` of
 * registration.ts says, and the real LinkedIn does not know the ID. It
 * is part of every build, like the sandbox itself. So a sandbox connects
 * LinkedIn accounts in a pigy that has no application at LinkedIn at all.
 */
export const sandboxLinkedInClient: LinkedInClient = {
  clientId: "pigy-sandbox",
  clientSecret: "pigy-sim-linkedin-application-of-the-sandbox",
};

/**
 * The application that pigy is at the LinkedIn of `reach`, or undefined if
 * it is none there: a live workspace of a pigy whose operator has not
 * given it one.
 */
export function linkedInClientFor(
  reach: Reach,
  env: Bindings,
): LinkedInClient | undefined {
  return registrationFor(reach, sandboxLinkedInClient, {
    clientId: env.LINKEDIN_CLIENT_ID,
    clientSecret: env.LINKEDIN_CLIENT_SECRET,
  });
}
