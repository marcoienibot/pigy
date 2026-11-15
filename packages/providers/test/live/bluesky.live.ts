import { env } from "node:process";
import { setTimeout as wait } from "node:timers/promises";
import { z } from "zod";
import {
  type BlueskyCredentials,
  createBlueskyProvider,
  parseHandle,
} from "../../src/bluesky/index.ts";
import { privateJwkSchema } from "../../src/bluesky/jwt.ts";
import { blueskyLiveHarness } from "../conformance/bluesky-live.ts";
import { describeProvider } from "../conformance/spec.ts";

/**
 * The conformance suite against Bluesky, with the account that the
 * environment names. AGENTS.md says how to run it. NOT VERIFIED: it has
 * never run, because there is no test account yet. PLAN.md section 19 has
 * what the first run has to settle.
 *
 * What it needs, besides a handle:
 *
 * - A client that Bluesky can read: a pigy that is deployed, whose client
 *   metadata is at PIGY_LIVE_BLUESKY_CLIENT_ID, with the key in
 *   PIGY_LIVE_BLUESKY_CLIENT_KEY, a JWK with its private half and `kid`.
 * - The credentials of a session of that client with the account, in
 *   PIGY_LIVE_BLUESKY_CREDENTIALS, as the adapter keeps them: the JSON
 *   that `completeConnect` returns. Nothing in pigy hands them out yet:
 *   the first live run has to add a way to get them.
 *
 * A refresh replaces the refresh token, and the one it was given is
 * worthless afterwards. So a run spends the credentials that it is given:
 * the next run needs new ones. Within the run, the credentials are
 * renewed before each test, and the newest are kept for the next.
 *
 * Bluesky has no posts that only their author sees. What the run posts is
 * public until the test that made it deletes it. If a run is cut short,
 * delete what begins with "pigy conformance" by hand.
 */

const handle = parseHandle(env.PIGY_LIVE_BLUESKY_HANDLE ?? "");
const clientId = env.PIGY_LIVE_BLUESKY_CLIENT_ID;
const clientKey = privateJwkSchema
  .extend({ kid: z.string().min(1) })
  .safeParse(JSON.parse(env.PIGY_LIVE_BLUESKY_CLIENT_KEY ?? "null")).data;
const given = env.PIGY_LIVE_BLUESKY_CREDENTIALS;
if (!handle || !clientId || !clientKey || !given) {
  throw new Error(
    "Set PIGY_LIVE_BLUESKY_HANDLE, PIGY_LIVE_BLUESKY_CLIENT_ID, PIGY_LIVE_BLUESKY_CLIENT_KEY and PIGY_LIVE_BLUESKY_CREDENTIALS.",
  );
}
const { kid, ...privateKey } = clientKey;
const keys = [{ id: kid, privateKey }];

// The only use of the real `fetch` and of the real clock in a test of
// this repository.
const fetch: typeof globalThis.fetch = (input, init) =>
  globalThis.fetch(input, init);
const now = () => new Date();
const provider = createBlueskyProvider({
  fetch,
  now,
  clientIdFor: () => clientId,
  keys: async () => keys,
});

// The posts of this run are unlike those of any other run.
const tag = `pigy conformance ${new Date().toISOString()} ${crypto.randomUUID().slice(0, 8)}`;

let current = JSON.parse(given) as BlueskyCredentials;

describeProvider(`Bluesky, live as ${handle}`, async () => {
  // Renewed for every test: an access token lasts minutes.
  current = (await provider.refresh?.(current))
    ?.credentials as BlueskyCredentials;
  return blueskyLiveHarness({
    fetch,
    now,
    clientId,
    keys,
    handle,
    credentials: current,
    tag,
    sleep: async (seconds) => {
      await wait(seconds * 1000);
    },
  });
});
