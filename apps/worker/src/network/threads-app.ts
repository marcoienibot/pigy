import type { Bindings } from "../env.ts";
import type { Reach } from "./reach.ts";

/**
 * pigy as an app of Threads. Like LinkedIn, Threads knows an app only as
 * whoever runs it has made it, here in Meta's dashboard for developers:
 * an app with the use case "Access the Threads API", the permissions that
 * pigy asks for, and the callback address of this pigy. The use case has
 * an ID and a secret of its own, which are not those of the Meta app
 * around it: they are the secrets `THREADS_APP_ID` and
 * `THREADS_APP_SECRET`.
 */

/** An app of Threads: what Meta's dashboard hands out for the use case. */
export type ThreadsApp = { appId: string; appSecret: string };

/**
 * The app that pigy is in the simulated Threads of every sandbox, which
 * the world of a sandbox is made with: src/sim/object.ts.
 *
 * It is here for everybody to read, and that is fine, as for the
 * application of the simulated LinkedIn in linkedin-client.ts: it is good
 * in a simulated world and nowhere else. Its secret is marked as a
 * simulated one, which no real service takes. The app of the operator's
 * never goes into a simulated world. So a sandbox connects Threads
 * accounts in a pigy that has no app at Meta at all.
 */
export const sandboxThreadsApp: ThreadsApp = {
  appId: "1000000000000001",
  appSecret: "pigy-sim-threads-app-of-the-sandbox",
};

/**
 * The app that pigy is at the Threads of `reach`, or undefined if it is
 * none there: a live workspace of a pigy whose operator has not given it
 * one.
 */
export function threadsAppFor(
  reach: Reach,
  env: Bindings,
): ThreadsApp | undefined {
  if (reach.simulated) return sandboxThreadsApp;
  const { THREADS_APP_ID: appId, THREADS_APP_SECRET: appSecret } = env;
  return appId && appSecret ? { appId, appSecret } : undefined;
}
