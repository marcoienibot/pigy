import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { expect, test } from "../fixtures.ts";
import {
  expectNoOtherServer,
  expectOwnServer,
  expectOwnServerInTest,
  loopback,
  OtherServer,
  serverOn,
} from "../server.ts";

// The check that a run tests its own server, which fixtures.ts makes before
// and after every test, against servers of these tests' own. Each listens
// on a port that the system chooses, never on the port of the run: the
// browsers of the other tests go there.

/** Serves `handler` at `address`, on `port` or one that the system chooses. */
async function serve(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  { address = loopback, port = 0 } = {},
) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, address, resolve);
  });
  return {
    port: (server.address() as { port: number }).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A made-up ID of an e2e build, as apps/web/vite.config.ts makes them. */
const buildId = () => `pigy-e2e-build ${randomUUID()}`;

/**
 * The ID of the build of the run. `expectOwnServer` compares it with the
 * build of this checkout before it asks a server, so a test of that
 * function has its servers serve this one.
 */
function buildOfRun(): string {
  const build = process.env.PIGY_E2E_BUILD;
  if (build === undefined) throw new Error("PIGY_E2E_BUILD is not set");
  return build;
}

test("a server of the build of the run is the run's own", async () => {
  const build = buildId();
  const server = await serve((_, response) => response.end(build));
  try {
    expect(await serverOn(server.port, build)).toEqual({ kind: "ours" });
  } finally {
    await server.close();
  }
});

test("a server of another e2e build is a stranger", async () => {
  // Another checkout's build, or one that this checkout made before.
  const other = buildId();
  const server = await serve((_, response) => response.end(other));
  try {
    expect(await serverOn(server.port, buildId())).toEqual({
      kind: "stranger",
      what: `http://${loopback}:${server.port} serves the e2e build "${other}"`,
    });
  } finally {
    await server.close();
  }
});

test("a server that answers without the ID of an e2e build is a stranger", async () => {
  const build = buildId();
  // Another program, or a build of pigy that has no ID: it serves the app
  // shell for a file that it does not have, with a 200, or answers 404.
  for (const [status, body] of [
    [200, "<!doctype html>"],
    [404, "Not found"],
  ] as const) {
    const server = await serve((_, response) => {
      response.statusCode = status;
      response.end(body);
    });
    try {
      expect(await serverOn(server.port, build)).toMatchObject({
        kind: "stranger",
        what: expect.stringContaining(
          `answers with ${status} and no ID of an e2e build`,
        ),
      });
    } finally {
      await server.close();
    }
  }
});

test("a port that nothing listens on has nothing", async () => {
  // A port that was free a moment ago, and that nothing asks for by number.
  const server = await serve(() => {});
  await server.close();
  expect(await serverOn(server.port, buildId())).toEqual({ kind: "nothing" });
});

test("a server that does not answer is not taken for a stranger", async () => {
  // It takes the connection and never answers, as a server of the run that
  // is stuck would. Nothing else can be on the port of the run while that
  // server holds it.
  let asked = 0;
  const server = await serve(() => {
    asked += 1;
  });
  try {
    expect(
      await serverOn(server.port, buildId(), { timeout: 200, pause: 10 }),
    ).toEqual({
      kind: "unanswered",
      reason: "it did not answer within 0.2 seconds",
    });
    // Asked twice before giving up.
    expect(asked).toBe(2);
  } finally {
    await server.close();
  }
});

test("a server whose first answer breaks off is asked again", async () => {
  const build = buildId();
  let asked = 0;
  const server = await serve((request, response) => {
    asked += 1;
    if (asked === 1) request.socket.destroy();
    else response.end(build);
  });
  try {
    expect(await serverOn(server.port, build, { pause: 10 })).toEqual({
      kind: "ours",
    });
    expect(asked).toBe(2);
  } finally {
    await server.close();
  }
});

test("a server that answers with an error of its own is asked again", async () => {
  const build = buildId();
  let asked = 0;
  // As the server of the run answers while its Workers runtime is not
  // there, and then as it answers when the runtime is.
  const server = await serve((_, response) => {
    asked += 1;
    if (asked === 1) {
      response.statusCode = 503;
      response.end("Service Unavailable");
    } else response.end(build);
  });
  try {
    expect(await serverOn(server.port, build, { pause: 10 })).toEqual({
      kind: "ours",
    });
    expect(asked).toBe(2);
  } finally {
    await server.close();
  }
});

test("a server that keeps answering with an error of its own is not taken for a stranger", async () => {
  const build = buildOfRun();
  let asked = 0;
  // The server of the run whose Workers runtime has died: the port is
  // still its own, and it has no ID to answer with.
  const server = await serve((_, response) => {
    asked += 1;
    response.statusCode = 500;
    response.end("Internal Server Error");
  });
  try {
    expect(await serverOn(server.port, build, { pause: 10 })).toEqual({
      kind: "failing",
      status: 500,
    });
    expect(asked).toBe(2);

    const failure = await expectOwnServer(server.port, build, "testing", {
      pause: 10,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    // Not the error that is recorded as another server on the port.
    expect(failure).not.toBeInstanceOf(OtherServer);
    expect((failure as Error).message).toContain("answered with 500");
  } finally {
    await server.close();
  }
});

test("a server that starts is waited for until it answers, a server of a test is asked twice", async () => {
  const build = buildOfRun();
  let asked = 0;
  // The server of a run that has said where it listens: it takes requests
  // and leaves them without an answer until its Workers runtime is ready,
  // here from the fifth request on. Two requests are one check, so that is
  // later than a single check waits.
  const server = await serve((_, response) => {
    asked += 1;
    if (asked >= 5) response.end(build);
  });
  const asking = { timeout: 100, pause: 10 };
  try {
    await expectOwnServer(server.port, build, "starting", asking);
    expect(asked).toBe(5);

    // During the run, the same server is given up after two requests.
    asked = 0;
    await expect(
      expectOwnServer(server.port, build, "testing", asking),
    ).rejects.toThrow("did not answer which build it serves, when asked twice");
    expect(asked).toBe(2);
  } finally {
    await server.close();
  }
});

test("a server that starts and never answers fails the run when its time is over", async () => {
  let asked = 0;
  const server = await serve(() => {
    asked += 1;
  });
  try {
    const failure = await expectOwnServer(
      server.port,
      buildOfRun(),
      "starting",
      { patience: 500, timeout: 100, pause: 10 },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(OtherServer);
    expect((failure as Error).message).toContain(
      "within 0.5 seconds of saying where it listens",
    );
    // More than the two requests of one check, and it did end.
    expect(asked).toBeGreaterThan(2);
  } finally {
    await server.close();
  }
});

test("another server on the port fails the run at its end, a server that does not answer does not", async () => {
  const build = buildOfRun();
  // What the tests of the run write to, and its end reads. This test has
  // a file of its own for as long as it runs: what it finds must not fail
  // the run that it is part of. A worker runs one test at a time, so no
  // other test writes there.
  const ofRun = process.env.PIGY_E2E_OTHER_SERVERS;
  process.env.PIGY_E2E_OTHER_SERVERS = test.info().outputPath("other-servers");
  try {
    // Nothing found: the file is not there, and the run does not fail.
    expectNoOtherServer();

    // The server of the run that is stuck fails the test that asked it,
    // and is not held against the run.
    const stuck = await serve(() => {});
    try {
      await expect(
        expectOwnServerInTest(stuck.port, build, { timeout: 100, pause: 10 }),
      ).rejects.toThrow("did not answer");
    } finally {
      await stuck.close();
    }
    expectNoOtherServer();

    const other = buildId();
    const stranger = await serve((_, response) => response.end(other));
    let found: Error;
    try {
      found = await expectOwnServerInTest(stranger.port, build).then(
        () => {
          throw new Error(
            "The check took a stranger for the server of the run",
          );
        },
        (error: Error) => error,
      );
      expect(found).toBeInstanceOf(OtherServer);
      // The check after the test finds the same, which the end of the run
      // says once.
      await expect(expectOwnServerInTest(stranger.port, build)).rejects.toThrow(
        OtherServer,
      );
    } finally {
      await stranger.close();
    }
    let end: unknown;
    try {
      expectNoOtherServer();
    } catch (error) {
      end = error;
    }
    expect(end).toBeInstanceOf(Error);
    expect((end as Error).message).toBe(
      `2 tests found that the run was not testing its own server or its own build, so the run fails, also where the test passed when it was tried again:\n- ${found.message}`,
    );
  } finally {
    if (ofRun === undefined) delete process.env.PIGY_E2E_OTHER_SERVERS;
    else process.env.PIGY_E2E_OTHER_SERVERS = ofRun;
  }
});

test("the check tells the server of the run from another and from one that breaks off", async () => {
  // Another server is an `OtherServer`, which is what fails the run. A
  // server that does not answer is a plain error: it is the run's own,
  // which can be slow.
  const build = buildOfRun();

  const ours = await serve((_, response) => response.end(build));
  try {
    await expectOwnServer(ours.port, build, "testing");
  } finally {
    await ours.close();
  }

  const stranger = await serve((_, response) => response.end(buildId()));
  try {
    await expect(
      expectOwnServer(stranger.port, build, "testing"),
    ).rejects.toThrow(OtherServer);
  } finally {
    await stranger.close();
  }

  // Stops answering once the request has arrived, before it answers.
  const broken = await serve((request) => request.socket.destroy());
  try {
    const failure = await expectOwnServer(broken.port, build, "testing").catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(OtherServer);
    expect((failure as Error).message).toContain("did not answer");
  } finally {
    await broken.close();
  }
});

test("the browser and Playwright's own requests go to the address of the run alone", async ({
  browser,
}) => {
  // A server at each address of localhost, on the same port. The browser
  // and Playwright would try ::1 first, and take it when 127.0.0.1 has
  // nothing: playwright.config.ts and fixtures.ts make both go to
  // `loopback` and nowhere else.
  const ours = await serve((_, response) => response.end("ours"));
  const other = await serve((_, response) => response.end("other"), {
    address: "::1",
    port: ours.port,
  }).catch((error: NodeJS.ErrnoException) => {
    // A machine without IPv6 has no other address.
    if (error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT") {
      return undefined;
    }
    throw error;
  });
  if (other === undefined) {
    await ours.close();
    test.skip(true, "This machine has no ::1");
    return;
  }
  const url = `http://localhost:${ours.port}/`;
  try {
    // Not the context of `page`, which may only talk to the app. This one
    // talks to localhost alone, like the app.
    const context = await browser.newContext({ serviceWorkers: "block" });
    try {
      const page = await context.newPage();
      expect(await (await page.goto(url))?.text()).toBe("ours");
      expect(await (await context.request.get(url)).text()).toBe("ours");

      // With nothing at 127.0.0.1, neither goes to ::1. A new context, so
      // that no connection to the first server is used again.
      await ours.close();
      const after = await browser.newContext({ serviceWorkers: "block" });
      try {
        await expect((await after.newPage()).goto(url)).rejects.toThrow(
          "ERR_CONNECTION_REFUSED",
        );
        await expect(after.request.get(url)).rejects.toThrow(
          `ECONNREFUSED ${loopback}:${ours.port}`,
        );
      } finally {
        await after.close();
      }
    } finally {
      await context.close();
    }
  } finally {
    await ours.close();
    await other.close();
  }
});
