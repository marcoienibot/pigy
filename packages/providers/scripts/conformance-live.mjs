// Runs the conformance suite against a real network, with a real account:
//
//   pnpm --filter @pigy/providers conformance:live <network>
//
// This is the only way to start that run, and the run is the only test of
// this repository that reaches a real host. It is for a person at a
// terminal. It refuses to start in CI, and without the credentials of a
// test account in the environment. AGENTS.md has the details.
import { spawnSync } from "node:child_process";
import { argv, env, exit } from "node:process";
import { fileURLToPath } from "node:url";

// What each network's run reads from the environment.
const networks = {
  mastodon: [
    "PIGY_LIVE_MASTODON_INSTANCE",
    "PIGY_LIVE_MASTODON_ACCESS_TOKEN",
    "PIGY_LIVE_MASTODON_CLIENT_ID",
    "PIGY_LIVE_MASTODON_CLIENT_SECRET",
  ],
};

const network = argv[2];
if (env.CI) {
  console.error("The live conformance run does not run in CI.");
  exit(1);
}
if (!network || !Object.hasOwn(networks, network)) {
  console.error(
    `Usage: conformance-live.mjs <${Object.keys(networks).join("|")}>`,
  );
  exit(2);
}
const missing = networks[network].filter((name) => !env[name]);
if (missing.length > 0) {
  console.error(
    `The live run against ${network} needs these in the environment: ${missing.join(", ")}`,
  );
  exit(2);
}

console.log(
  `Running the conformance suite against the real ${network}. It posts to the account whose credentials it was given, and deletes what it posted.`,
);
const result = spawnSync(
  "vitest",
  ["run", "--config", "vitest.live.config.ts", `test/live/${network}.live.ts`],
  {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: "inherit",
    // What test/live/setup.ts looks for.
    env: {
      ...env,
      PIGY_LIVE_CONFORMANCE: "started-by-conformance-live-script",
    },
  },
);
if (result.error) console.error(result.error.message);
exit(result.status ?? 1);
