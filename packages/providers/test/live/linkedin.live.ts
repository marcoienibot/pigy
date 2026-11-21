import { env } from "node:process";
import { setTimeout as wait } from "node:timers/promises";
import { linkedInLiveHarness } from "../conformance/linkedin-live.ts";
import { describeProvider } from "../conformance/spec.ts";

/**
 * The conformance suite against the real LinkedIn, with the application
 * and the member that the environment names. AGENTS.md says how to run it.
 * NOT VERIFIED: it has never run against LinkedIn.
 *
 * LinkedIn has no posts that only their author sees: the run posts for
 * the connections of the member, and deletes what it posted after every
 * test. If a run is cut short, look for posts that begin with "pigy
 * conformance" and delete them by hand.
 */

const clientId = env.PIGY_LIVE_LINKEDIN_CLIENT_ID;
const clientSecret = env.PIGY_LIVE_LINKEDIN_CLIENT_SECRET;
const accessToken = env.PIGY_LIVE_LINKEDIN_ACCESS_TOKEN;
const memberId = env.PIGY_LIVE_LINKEDIN_MEMBER_ID;
if (!clientId || !clientSecret || !accessToken || !memberId) {
  throw new Error(
    "Set PIGY_LIVE_LINKEDIN_CLIENT_ID, PIGY_LIVE_LINKEDIN_CLIENT_SECRET, PIGY_LIVE_LINKEDIN_ACCESS_TOKEN and PIGY_LIVE_LINKEDIN_MEMBER_ID.",
  );
}

// The posts of this run are unlike those of any other: LinkedIn refuses a
// text that the member has posted in the last minutes.
const tag = `pigy conformance ${new Date().toISOString()} ${crypto.randomUUID().slice(0, 8)}`;

describeProvider("LinkedIn, live", async () =>
  linkedInLiveHarness({
    // The only use of the real `fetch` in a test of this repository, with
    // the live runs of the other networks.
    fetch: (input, init) => fetch(input, init),
    now: () => new Date(),
    clientId,
    clientSecret,
    credentials: { accessToken, memberId },
    tag,
    sleep: async (seconds) => {
      await wait(seconds * 1000);
    },
  }),
);
