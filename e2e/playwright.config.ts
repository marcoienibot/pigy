import { defineConfig, devices } from "@playwright/test";
import { portFromEnvironment } from "./server.ts";

// The port of the server that the run starts: `PIGY_E2E_PORT`, or 4173.
// A run whose server is not the one on its port fails, see server.ts.
const port = portFromEnvironment() ?? 4173;
process.env.PIGY_E2E_PORT = String(port);

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "retain-on-failure",
    launchOptions: {
      // Tests must never reach a real network host. With this rule the
      // browser resolves no host but "localhost", addresses such as 127.0.0.1
      // included, so it has nowhere else to connect to. That stops what
      // fixtures.ts cannot: a redirect to another host, and a WebSocket
      // opened in a worker, where Playwright does not route them. The app
      // must therefore be addressed as "localhost". The switch is Chromium's
      // own, so every project has to run a Chromium browser.
      args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost"],
    },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
  // Tests run against a build, served by the Workers runtime the same way
  // it is deployed: static assets plus the Worker. It is the production
  // build in everything but sign-in, where a simulated Google stands in for
  // the real one. `pnpm preview:e2e` builds it and serves it on the port of
  // `PIGY_E2E_PORT`, with an empty database.
  webServer: {
    command: "pnpm preview:e2e",
    cwd: "..",
    env: { PIGY_E2E_PORT: String(port) },
    url: `http://localhost:${port}/api/health`,
    // Always build: a server that is already running could serve a stale
    // build.
    reuseExistingServer: false,
  },
  // Playwright only waits for the port to answer. This makes sure that the
  // server that answers is the one that it started.
  globalSetup: "./global-setup.ts",
});
