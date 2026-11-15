import { defineConfig } from "vitest/config";

// The unit tests of the web app, which run in Node. This is a file of its
// own so that they do not start the Worker, as vite.config.ts would.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
  },
});
