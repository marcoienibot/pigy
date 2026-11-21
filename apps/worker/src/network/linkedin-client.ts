import type { Bindings } from "../env.ts";
import type { Reach } from "./reach.ts";

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
 * simulated world and nowhere else. Its secret is marked as a simulated
 * one, which no real service takes, and the real LinkedIn does not know
 * the ID. It is part of every build, like the sandbox itself. The
 * application of the operator's never goes into a simulated world: a
 * simulator would refuse its secret unread, and it has no business there.
 * So a sandbox connects LinkedIn accounts in a pigy that has no
 * application at LinkedIn at all.
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
  if (reach.simulated) return sandboxLinkedInClient;
  const { LINKEDIN_CLIENT_ID: clientId, LINKEDIN_CLIENT_SECRET: clientSecret } =
    env;
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}
