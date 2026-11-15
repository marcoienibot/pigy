import { env } from "node:process";
import { setTimeout as wait } from "node:timers/promises";
import { parseInstanceDomain } from "../../src/mastodon/index.ts";
import { mastodonLiveHarness } from "../conformance/mastodon-live.ts";
import { describeProvider } from "../conformance/spec.ts";

/**
 * The conformance suite against a real Mastodon server, with the account
 * that the environment names. AGENTS.md says how to run it. NOT VERIFIED:
 * it has never run against a real server.
 *
 * It posts with the visibility "direct", which only the account itself
 * sees, and deletes what it posted after every test. If a run is cut
 * short, look for posts that begin with "pigy conformance" and delete them
 * by hand. It also registers one application with the instance, named
 * "pigy conformance run", which Mastodon has no way to remove through its
 * API.
 */

const domain = parseInstanceDomain(env.PIGY_LIVE_MASTODON_INSTANCE ?? "");
const accessToken = env.PIGY_LIVE_MASTODON_ACCESS_TOKEN;
const clientId = env.PIGY_LIVE_MASTODON_CLIENT_ID;
const clientSecret = env.PIGY_LIVE_MASTODON_CLIENT_SECRET;
if (!domain || !accessToken || !clientId || !clientSecret) {
  throw new Error(
    "Set PIGY_LIVE_MASTODON_INSTANCE, PIGY_LIVE_MASTODON_ACCESS_TOKEN, PIGY_LIVE_MASTODON_CLIENT_ID and PIGY_LIVE_MASTODON_CLIENT_SECRET.",
  );
}

// The posts of this run, and the keys they are sent with, are unlike those
// of any other run: Mastodon remembers a key for an hour.
const tag = `pigy conformance ${new Date().toISOString()} ${crypto.randomUUID().slice(0, 8)}`;

describeProvider(`Mastodon, live at ${domain}`, async () =>
  mastodonLiveHarness({
    // The only use of the real `fetch` in a test of this repository.
    fetch: (input, init) => fetch(input, init),
    now: () => new Date(),
    credentials: { domain, accessToken, clientId, clientSecret },
    tag,
    sleep: async (seconds) => {
      await wait(seconds * 1000);
    },
  }),
);
