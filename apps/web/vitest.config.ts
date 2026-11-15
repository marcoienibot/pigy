import { defineConfig } from "vitest/config";

// The unit tests of the web app, which run in Node. This is a file of its
// own so that they do not start the Worker, as vite.config.ts would.
export default defineConfig({
  resolve: {
    // The "@/" alias from tsconfig.app.json, as in vite.config.ts: a module
    // of the app that a test imports may import others by it.
    tsconfigPaths: true,
  },
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
  },
});
