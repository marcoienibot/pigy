// Brings a local D1 database up to date with the SQL files in `migrations`.
//
//   node scripts/migrate-local.mjs [--fresh] [state directory]
//
// The state directory is where the local Workers runtime keeps its data, by
// default the one that `pnpm dev` uses. `--fresh` empties it first.
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

const args = process.argv.slice(2);
const stateDirectory =
  args.find((arg) => !arg.startsWith("--")) ?? ".wrangler/state";

if (args.includes("--fresh")) {
  rmSync(stateDirectory, { recursive: true, force: true });
}

const { status, stdout, stderr } = spawnSync(
  "wrangler",
  [
    "d1",
    "migrations",
    "apply",
    "DB",
    "--local",
    "--persist-to",
    stateDirectory,
  ],
  {
    encoding: "utf8",
    // Without a terminal on its input, wrangler applies the migrations
    // without asking first.
    stdio: ["ignore", "pipe", "pipe"],
    // Windows finds the wrangler command only through a shell.
    shell: process.platform === "win32",
  },
);

// Wrangler prints a banner and a table. They are only worth reading when
// something went wrong.
if (status !== 0) {
  process.stderr.write(stdout + stderr);
  process.exit(status ?? 1);
}
