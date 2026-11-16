import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectOwnServer, portFromEnvironment } from "./server.ts";

/**
 * Runs once the server of the run has said where it listens, before any
 * test: Playwright starts the `webServer` of the config first, and sets
 * `PIGY_E2E_PORT` and `PIGY_E2E_BUILD` from what it said. Fails the run if
 * what answers there is not that server, and the workers check it again
 * before and after every test: see server.ts.
 *
 * Returns the teardown of the run, which fails the run if a test found
 * another server or another build. A test that fails like that is tried
 * again where retries are allowed, and passes if the server of the run is
 * back by then, but the run did test something else.
 */
export default async function globalSetup(): Promise<() => void> {
  const port = portFromEnvironment();
  const build = process.env.PIGY_E2E_BUILD;
  if (!port || build === undefined) {
    throw new Error(
      "The server of the run has not said its port and the ID of its build: see webServer in playwright.config.ts",
    );
  }
  await expectOwnServer(port, build, "starting");

  // What `recordOtherServer` of server.ts writes to. The workers are
  // started after this, with the environment of the runner.
  const directory = mkdtempSync(join(tmpdir(), "pigy-e2e-"));
  const file = join(directory, "other-servers");
  process.env.PIGY_E2E_OTHER_SERVERS = file;

  return () => {
    let found: string[];
    try {
      found = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as string);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      found = [];
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    if (found.length > 0) {
      throw new Error(
        `${found.length === 1 ? "A test" : `${found.length} tests`} found that the run was not testing its own server or its own build, so the run fails, also where the test passed when it was tried again:\n${[...new Set(found)].map((message) => `- ${message}`).join("\n")}`,
      );
    }
  };
}
