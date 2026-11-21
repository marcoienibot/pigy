// The server that a run of the browser tests starts, and how a run makes
// sure that it tests that server and no other.
//
// Every checkout on a machine serves its e2e build on a port of the same
// machine, and the browser goes to whatever answers on the port of the run.
// The run learns its port from the output of its own server, which says
// where it listens once it does, so no other server can stand in for it
// at the start: one that takes the port in the moment between the server
// choosing it and listening on it keeps the server from starting. Later
// another can stand in: Playwright does not notice that its server
// has exited, and another can then take the port. And another `pnpm e2e`
// or `pnpm preview:e2e` in the same checkout builds over the build that
// the run tests, and empties its database.
//
// So every e2e build has an ID of its own, a random one that apps/web
// writes into it and says in the output of the build (`e2eBuildId` in
// apps/web/vite.config.ts), and the run compares the ID that its build
// said with what the server on its port serves and with the file in this
// checkout's build: once when the server is up, in global-setup.ts, and
// before and after every test, in fixtures.ts.
//
// A server that says where it listens is not ready yet: it answers once
// the Workers runtime behind it is, and until then leaves every request
// waiting. So the first check is also the wait for that, and is given as
// long as a server has to start: `expectOwnServer`.

import { appendFileSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

/**
 * The address of `localhost` that the server of the run listens on, and
 * the only one that the tests go to: the browser by the resolver rule in
 * playwright.config.ts, Playwright's own requests by `loopbackOnly` in
 * fixtures.ts. `localhost` is also ::1, which the browser and Playwright
 * would try first, and where another server can listen on the same port
 * without the server of the run noticing. apps/web/vite.config.ts has the
 * same address.
 */
export const loopback = "127.0.0.1";

/** Where the server has the ID of its build. */
const buildIdPath = "/e2e-build.txt";

/** The same file in this checkout's e2e build. */
const ownBuildFile = fileURLToPath(
  new URL(`../apps/web/dist-e2e/client${buildIdPath}`, import.meta.url),
);

/**
 * The value of `PIGY_E2E_PORT`, if it is set. 0 has the server choose a
 * port, after which Playwright sets the variable to the one it chose: see
 * playwright.config.ts.
 */
export function portFromEnvironment(): number | undefined {
  const value = process.env.PIGY_E2E_PORT;
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!/^\d+$/.test(value) || port > 65535) {
    throw new Error(`PIGY_E2E_PORT is "${value}", which is not a port`);
  }
  return port;
}

/** The ID of this checkout's e2e build, or undefined if it has none. */
function ownBuild(): string | undefined {
  try {
    return readFileSync(ownBuildFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** What the port answered when it was asked for the ID of the build. */
type Answer =
  | { kind: "nothing" }
  | { kind: "answer"; status: number; body: string }
  | { kind: "failed"; reason: string };

/**
 * Asks the port for the ID of the build that it serves, the way the
 * browser asks the app: at `loopback`, for `localhost` and the port.
 */
function ask(port: number, timeout: number): Promise<Answer> {
  return new Promise((resolve) => {
    const asking = request(
      {
        host: loopback,
        port,
        path: buildIdPath,
        headers: { Host: `localhost:${port}` },
        // A connection of its own: one that a check before has left open
        // can be closed by the server as it is used again.
        agent: false,
        timeout,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () =>
          resolve({ kind: "answer", status: response.statusCode ?? 0, body }),
        );
        response.on("error", (error) =>
          resolve({ kind: "failed", reason: error.message }),
        );
      },
    );
    asking.on("timeout", () =>
      asking.destroy(
        new Error(`it did not answer within ${timeout / 1000} seconds`),
      ),
    );
    asking.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") resolve({ kind: "nothing" });
      else resolve({ kind: "failed", reason: error.message });
    });
    asking.end();
  });
}

/** What answers on the port of the run. */
export type Server =
  /** The build of the run. */
  | { kind: "ours" }
  | { kind: "nothing" }
  /** Something else, and what it is. */
  | { kind: "stranger"; what: string }
  /**
   * Something that did not answer, twice, or broke off its answer, and
   * why. Nothing but the server of the run can be on its port while that
   * runs, so this is most likely the server of the run, which is stuck or
   * overloaded.
   */
  | { kind: "unanswered"; reason: string }
  /**
   * Something that answered with an error of its own, twice, and the
   * status of the second. That says nothing about whose server it is: the
   * server of the run answers like that when the Workers runtime behind it
   * has not started or has died.
   */
  | { kind: "failing"; status: number };

/** How long a check waits for an answer, and before it asks again. */
type Asking = { timeout?: number; pause?: number };

/**
 * What answers on `localhost:<port>`, where a server of the build `build`
 * is expected. An answer that does not come, or that is an error of the
 * server, a 5xx, is asked for a second time after `pause` milliseconds: a
 * server under load can be slow once.
 */
export async function serverOn(
  port: number,
  build: string,
  { timeout = 5000, pause = 1000 }: Asking = {},
): Promise<Server> {
  let answer = await ask(port, timeout);
  if (
    answer.kind === "failed" ||
    (answer.kind === "answer" && answer.status >= 500)
  ) {
    await sleep(pause);
    answer = await ask(port, timeout);
  }
  if (answer.kind === "nothing") return { kind: "nothing" };
  if (answer.kind === "failed") {
    return { kind: "unanswered", reason: answer.reason };
  }
  if (answer.status >= 500) return { kind: "failing", status: answer.status };
  if (answer.status === 200 && answer.body === build) return { kind: "ours" };
  const url = `http://${loopback}:${port}`;
  if (answer.status === 200 && answer.body.startsWith("pigy-e2e-build ")) {
    return {
      kind: "stranger",
      what: `${url} serves the e2e build "${answer.body}"`,
    };
  }
  return {
    kind: "stranger",
    what: `${url} answers with ${answer.status} and no ID of an e2e build: it is another program, a build of pigy that is not for the e2e tests, or one from before e2e builds had IDs`,
  };
}

/**
 * Thrown when the run is not testing its own server, or not its own build.
 * A test that passes on a retry after this does not make up for it: see
 * `expectOwnServerInTest`.
 */
export class OtherServer extends Error {}

/**
 * Throws unless the server on `port` is the one that the run started, of
 * the build `build` that it said, and this checkout still has that build.
 * `when` says whether the run is starting, in global-setup.ts, or a test
 * is about to run or has run, in fixtures.ts.
 *
 * A server that is starting has `patience` milliseconds to answer, and is
 * asked for as long: it listens before the Workers runtime behind it is
 * ready, and a request waits for that. The time is what Playwright gives
 * a `webServer` to start. During the run the server has answered before,
 * so one that does not answer when asked twice fails the test.
 */
export async function expectOwnServer(
  port: number,
  build: string,
  when: "starting" | "testing",
  { patience = 60_000, ...asking }: Asking & { patience?: number } = {},
): Promise<void> {
  // The server reads the files of its build on every request, so a build
  // that changes under it changes what it serves.
  const now = ownBuild();
  if (now !== build) {
    throw new OtherServer(
      `This checkout's e2e build has changed ${when === "starting" ? "since the server of this run built it" : "during the run"}: ${now === undefined ? "it is gone" : `it is now "${now}"`}, and the run built "${build}". Another pnpm e2e or pnpm preview:e2e in this checkout has built over the build that this run tests, which its server now serves, and may have emptied its database. A checkout serves one e2e build at a time.`,
    );
  }
  const deadline = Date.now() + patience;
  let server = await serverOn(port, build, asking);
  while (
    when === "starting" &&
    server.kind === "unanswered" &&
    Date.now() < deadline
  ) {
    // An answer that breaks off at once would otherwise be asked for
    // without a pause.
    await sleep(asking.pause ?? 1000);
    server = await serverOn(port, build, asking);
  }
  const stopped =
    when === "starting"
      ? "The server of this run stopped as soon as it had started"
      : "The server of this run stopped during the run";
  switch (server.kind) {
    case "ours":
      return;
    case "nothing":
      throw new OtherServer(
        `Nothing answers on port ${port} any more. ${stopped}.`,
      );
    case "stranger":
      throw new OtherServer(
        `Port ${port} is not served by the server that this run started: ${server.what}, while the build of this run is "${build}". ${stopped}, and another server took the port.`,
      );
    case "unanswered":
      throw new Error(
        `The server on port ${port} did not answer which build it serves, ${when === "starting" ? `within ${patience / 1000} seconds of saying where it listens` : "when asked twice"}: ${server.reason}. It is most likely the server of this run, which is stuck or overloaded.`,
      );
    case "failing":
      throw new Error(
        `The server on port ${port} answered with ${server.status} when asked which build it serves, twice. It is most likely the server of this run, whose Workers runtime ${when === "starting" ? "did not start" : "has stopped"}: see the output of the server.`,
      );
  }
}

/**
 * The file in which the tests of a run note that they found another server
 * or another build. global-setup.ts names it in the environment before the
 * workers are started.
 */
function otherServersFile(): string {
  const file = process.env.PIGY_E2E_OTHER_SERVERS;
  if (file === undefined) {
    throw new Error(
      "PIGY_E2E_OTHER_SERVERS is not set: global-setup.ts has not run",
    );
  }
  return file;
}

/**
 * The check of a test, before it and after it: `expectOwnServer`, which
 * also notes for the run that it found another server or another build.
 * The test fails, and the run fails at its end even if the test passes
 * when it is tried again: see `expectNoOtherServer`. A server that does
 * not answer, or answers with an error of its own, fails the test alone:
 * it is the run's own as far as anybody can tell.
 */
export async function expectOwnServerInTest(
  port: number,
  build: string,
  asking: Asking = {},
): Promise<void> {
  try {
    await expectOwnServer(port, build, "testing", asking);
  } catch (error) {
    if (error instanceof OtherServer) {
      appendFileSync(otherServersFile(), `${JSON.stringify(error.message)}\n`);
    }
    throw error;
  }
}

/**
 * Throws if a test of the run has found another server or another build,
 * with what each found. For the end of the run: see global-setup.ts.
 */
export function expectNoOtherServer(): void {
  let found: string[];
  try {
    found = readFileSync(otherServersFile(), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as string);
  } catch (error) {
    // No test has written to it.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return;
  }
  if (found.length > 0) {
    throw new Error(
      `${found.length === 1 ? "A test" : `${found.length} tests`} found that the run was not testing its own server or its own build, so the run fails, also where the test passed when it was tried again:\n${[...new Set(found)].map((message) => `- ${message}`).join("\n")}`,
    );
  }
}
