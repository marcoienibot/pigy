import { defineConfig } from "vitest/config";

// For the conformance run against a real network, and for nothing else. It
// is started by scripts/conformance-live.mjs: test/live/setup.ts refuses
// every other start. `pnpm test` uses vitest.config.ts, which does not find
// the files of the live run and makes the global `fetch` throw.
export default defineConfig({
  test: {
    include: ["test/live/*.live.ts"],
    setupFiles: ["./test/live/setup.ts"],
    // A real network takes its time, and limits how fast it is asked.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
