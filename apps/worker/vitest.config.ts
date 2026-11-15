import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // In place of src/index.ts, to build the workspace objects with a
      // clock that the tests can move.
      main: "./test/main.ts",
      miniflare: {
        // Read here, in Node, because the Workers runtime has no file system.
        // test/setup.ts applies them.
        bindings: { TEST_MIGRATIONS: await readD1Migrations("./migrations") },
        // Second line of defence behind test/setup.ts: what gets past the
        // guard there reaches this Worker, never the network. It has to be a
        // Worker: with a function here, Miniflare lets TCP connections pass
        // through to the real network.
        outboundService: "deny-outbound",
        workers: [
          {
            name: "deny-outbound",
            modules: true,
            scriptPath: "./test/deny-outbound.js",
          },
        ],
      },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
    // Longer than a test waits for a workflow to get somewhere, `patience`
    // in test/publishing.ts, so that such a wait fails with what it waited
    // for and not with the test running out of time.
    testTimeout: 30_000,
  },
}));
