import { env } from "node:process";

// The live conformance run reaches real hosts and posts to a real account.
// This is what keeps it from starting by accident: it runs only when
// scripts/conformance-live.mjs started it, and never in CI. The script
// checks the same, so that nothing is spawned in the first place.
if (env.CI) {
  throw new Error("The live conformance run does not run in CI.");
}
if (env.PIGY_LIVE_CONFORMANCE !== "started-by-conformance-live-script") {
  throw new Error(
    "Start the live conformance run with: pnpm --filter @pigy/providers conformance:live <network>",
  );
}
