// The server that a run of the browser tests starts, and how a run makes
// sure that it tests that server and no other.
//
// Every checkout on a machine serves its e2e build on a port of the same
// machine, and the browser goes to whatever answers on the port of the run.
// That can be another checkout's build: one that took the port while this
// run was building, and kept it when this run's server could not start, or
// one that took it after this run's server had stopped. Playwright checks
// that the port is free before it starts the server and waits for the port
// to answer, but it cannot tell who answers, and it does not notice that
// its own server has exited once the port has answered.
//
// So every e2e build has an ID of its own, a random one that apps/web
// writes into it (`e2eBuildId` in apps/web/vite.config.ts), and the run
// compares what the server on its port serves with the file in this
// checkout's build: once when the server is up, in global-setup.ts, and
// before and after every test, in fixtures.ts.

import { readFileSync } from "node:fs";
import { request } from "node:http";
import { fileURLToPath } from "node:url";

/** Where the server has the ID of its build. */
const buildIdPath = "/e2e-build.txt";

/** The same file in this checkout's e2e build. */
const ownBuildFile = fileURLToPath(
  new URL(`../apps/web/dist-e2e/client${buildIdPath}`, import.meta.url),
);

/**
 * The addresses that `localhost` leads to. The server of the run listens
 * on one of them, the one that Node finds for `localhost`, which on a
 * machine whose hosts file names only 127.0.0.1 is that one. The browser
 * and Playwright's own requests try ::1 first, whatever the hosts file
 * says. So a server that listens on the other address and the same port
 * takes the browser's requests, and the server of the run does not notice
 * it when it starts, because the address that it takes is free.
 */
const loopback = ["127.0.0.1", "::1"] as const;

/** The value of `PIGY_E2E_PORT`, if it is set. */
export function portFromEnvironment(): number | undefined {
  const value = process.env.PIGY_E2E_PORT;
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!/^\d+$/.test(value) || port < 1 || port > 65535) {
    throw new Error(`PIGY_E2E_PORT is "${value}", which is not a port`);
  }
  return port;
}

/** The ID of this checkout's e2e build, or undefined if it has none. */
export function ownBuild(): string | undefined {
  try {
    return readFileSync(ownBuildFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** What an address of `localhost` answered for the ID of the build. */
type Answer =
  | { kind: "nothing" }
  | { kind: "answer"; status: number; body: string }
  | { kind: "failed"; reason: string };

/**
 * Asks `address` for the ID of the build that it serves on `port`, the way
 * the browser asks the app: for `localhost` and the port.
 */
function ask(address: string, port: number): Promise<Answer> {
  return new Promise((resolve) => {
    const asking = request(
      {
        host: address,
        port,
        path: buildIdPath,
        headers: { Host: `localhost:${port}` },
        // A server of the run answers at once: it reads a small file.
        timeout: 5000,
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
      asking.destroy(new Error("it did not answer within 5 seconds")),
    );
    asking.on("error", (error: NodeJS.ErrnoException) => {
      // Nothing listens there. An address that the machine does not have
      // has nothing that could listen.
      if (
        ["ECONNREFUSED", "EADDRNOTAVAIL", "EAFNOSUPPORT"].includes(
          error.code ?? "",
        )
      )
        resolve({ kind: "nothing" });
      else resolve({ kind: "failed", reason: error.message });
    });
    asking.end();
  });
}

/**
 * Whether `localhost:<port>` is the server of the build `build`. It is when
 * something answers on the port, and everything that answers, at either
 * address of `localhost`, serves the ID `build`. Otherwise this says what
 * answers instead, if anything does.
 */
export async function serverOn(
  port: number,
  build: string | undefined,
): Promise<"ours" | "nothing" | { stranger: string }> {
  const answers = await Promise.all(
    loopback.map(async (address) => ({
      url: `http://${address.includes(":") ? `[${address}]` : address}:${port}`,
      answer: await ask(address, port),
    })),
  );
  const strangers = answers.flatMap(({ url, answer }) => {
    if (answer.kind === "nothing") return [];
    if (answer.kind === "failed") return [`${url} fails: ${answer.reason}`];
    if (answer.status === 200 && answer.body === build) return [];
    if (answer.status === 200 && answer.body.startsWith("pigy-e2e-build ")) {
      return [`${url} serves the e2e build "${answer.body}"`];
    }
    return [
      `${url} answers with ${answer.status} and no ID of an e2e build: it is another program, a build of pigy that is not for the e2e tests, or one from before e2e builds had IDs`,
    ];
  });
  if (strangers.length > 0) {
    const ours =
      build === undefined
        ? "this checkout has no e2e build"
        : `the build of this run is "${build}"`;
    return { stranger: `${strangers.join(", and ")}, while ${ours}` };
  }
  return answers.every(({ answer }) => answer.kind === "nothing")
    ? "nothing"
    : "ours";
}

/**
 * Throws unless the server on `port` is still the one that the run
 * started, with the build that it had then, which global-setup.ts has put
 * into the environment.
 */
export async function expectOwnServer(port: number): Promise<void> {
  const started = process.env.PIGY_E2E_BUILD;
  if (started === undefined) {
    throw new Error("PIGY_E2E_BUILD is not set: global-setup.ts has not run");
  }
  // The server reads the files of its build on every request, so a build
  // that changes under it changes what it serves.
  const now = ownBuild();
  if (now !== started) {
    throw new Error(
      `This checkout's e2e build has changed during the run: ${now === undefined ? "it is gone" : `it is now "${now}"`}, and the run started with "${started}". Another pnpm e2e or pnpm preview:e2e in this checkout has built over the build that this run tests, which its server now serves, and may have emptied its database. A checkout serves one e2e build at a time.`,
    );
  }
  const server = await serverOn(port, started);
  if (server === "nothing") {
    throw new Error(
      `Nothing answers on port ${port} any more: the server of this run has stopped.`,
    );
  }
  if (server !== "ours") {
    throw new Error(
      `Port ${port} is no longer served by the server that this run started: ${server.stranger}. The server of this run stopped during the run, and another server took the port.`,
    );
  }
}
