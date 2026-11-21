import { defineConfig, devices } from "@playwright/test";
import { loopback, portFromEnvironment } from "./server.ts";

// The port of the server that the run starts: `PIGY_E2E_PORT`, or, when it
// is unset or 0, one that the server chooses as it starts, after its
// build. Several checkouts on a machine run these tests, and a port of
// their own keeps the runs apart without anybody choosing one.
//
// Playwright loads this file in its runner, before the server has started,
// and again in every worker. The runner learns the port from the output of
// the server (`webServer.wait` below) and puts it into its environment
// before the global setup runs and before it starts the workers, so that
// a worker that loads this file finds it there.
const port = portFromEnvironment();

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    // Unknown in the runner when the server chooses the port, which does
    // not need it.
    ...(port ? { baseURL: `http://localhost:${port}` } : {}),
    trace: "retain-on-failure",
    launchOptions: {
      // Tests must never reach a real network host. With this rule the
      // browser resolves no host but "localhost", addresses such as 127.0.0.1
      // included, so it has nowhere else to connect to. That stops what
      // fixtures.ts cannot: a redirect to another host, and a WebSocket
      // opened in a worker, where Playwright does not route them. The app
      // must therefore be addressed as "localhost". The switch is Chromium's
      // own, so every project has to run a Chromium browser.
      //
      // "localhost" leads to the address that the server of the run listens
      // on and to no other, so that a server at the other address of
      // "localhost" on the same port is never asked: see server.ts.
      args: [
        `--host-resolver-rules=MAP localhost ${loopback}, MAP * ~NOTFOUND`,
      ],
    },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
  // Tests run against a build, served by the Workers runtime the same way
  // it is deployed: static assets plus the Worker. It is the production
  // build in everything but sign-in, where a simulated Google stands in for
  // the real one. `pnpm preview:e2e` builds it and serves it with an empty
  // database. Playwright always starts it: it has no address at which it
  // could find a server that is already running.
  webServer: {
    command: "pnpm preview:e2e",
    cwd: "..",
    env: { PIGY_E2E_PORT: String(port ?? 0) },
    // The server is ready when it says where it listens, after its build
    // has said its ID. Playwright puts both into the environment, under
    // the names of the groups in capitals: PIGY_E2E_BUILD and
    // PIGY_E2E_PORT. Only the process that Playwright started writes to
    // this output, so no other server can make the run start.
    wait: {
      stdout:
        /The ID of this e2e build is "(?<pigy_e2e_build>pigy-e2e-build [^"]+)"\.[\s\S]*Local:\s+http:\/\/127\.0\.0\.1:(?<pigy_e2e_port>\d+)\//,
    },
  },
  // Checks that the server that answers is the one that the run started.
  globalSetup: "./global-setup.ts",
});
