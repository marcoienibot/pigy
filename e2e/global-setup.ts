import { ownBuild, portFromEnvironment, serverOn } from "./server.ts";

/**
 * Runs once the server of the run answers on its port, before any test:
 * Playwright starts the `webServer` of the config first. Fails the run if
 * what answers is not the server that the run started, and hands the ID of
 * its build to the tests, which check it again: see server.ts.
 */
export default async function globalSetup(): Promise<void> {
  // playwright.config.ts has set it, for the server and for the workers.
  const port = portFromEnvironment();
  if (port === undefined) throw new Error("PIGY_E2E_PORT is not set");
  const build = ownBuild();
  const server = await serverOn(port, build);
  if (server === "nothing") {
    throw new Error(
      `Nothing answers on port ${port} any more. The server that answered there has stopped.`,
    );
  }
  if (server !== "ours" || build === undefined) {
    throw new Error(
      `Port ${port} is not served by the server that this run started: ${server === "ours" ? "this checkout has no e2e build" : server.stranger}. Another server took the port while this run was building its own, which then could not start. Run again, or choose a port that nothing else uses with PIGY_E2E_PORT.`,
    );
  }
  // The workers are started after this, with the environment of the runner.
  process.env.PIGY_E2E_BUILD = build;
}
