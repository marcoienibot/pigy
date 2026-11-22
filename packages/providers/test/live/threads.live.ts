import { env } from "node:process";
import { setTimeout as wait } from "node:timers/promises";
import { describeProvider } from "../conformance/spec.ts";
import { threadsLiveHarness } from "../conformance/threads-live.ts";

/**
 * The conformance suite against the real Threads, with the app and the
 * account that the environment names. AGENTS.md says how to run it.
 * NOT VERIFIED: it has never run against Threads.
 *
 * Threads has no posts that only their author sees: the run posts in
 * public, and deletes what it posted after every test. If a run is cut
 * short, look for posts that begin with "pigy conformance" and delete
 * them by hand.
 */

const appId = env.PIGY_LIVE_THREADS_APP_ID;
const appSecret = env.PIGY_LIVE_THREADS_APP_SECRET;
const accessToken = env.PIGY_LIVE_THREADS_ACCESS_TOKEN;
if (!appId || !appSecret || !accessToken) {
  throw new Error(
    "Set PIGY_LIVE_THREADS_APP_ID, PIGY_LIVE_THREADS_APP_SECRET and PIGY_LIVE_THREADS_ACCESS_TOKEN.",
  );
}

// The posts of this run are unlike those of any other.
const tag = `pigy conformance ${new Date().toISOString()} ${crypto.randomUUID().slice(0, 8)}`;

describeProvider("Threads, live", async () =>
  threadsLiveHarness({
    // The only use of the real `fetch` in a test of this repository, with
    // the live runs of the other networks.
    fetch: (input, init) => fetch(input, init),
    now: () => new Date(),
    appId,
    appSecret,
    credentials: { accessToken },
    tag,
    sleep: async (seconds) => {
      await wait(seconds * 1000);
    },
  }),
);
