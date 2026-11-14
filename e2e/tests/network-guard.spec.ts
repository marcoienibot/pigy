import { expect, test } from "../fixtures.ts";

// These tests prove the guard, which is the fixture in fixtures.ts and the
// resolver rule in playwright.config.ts, by breaking its rule. Their host is
// under the reserved ".invalid" domain or is this machine: if the guard ever
// stops working, the requests still cannot reach a real host.
const otherHost = "https://example.invalid/";

test("a request to another host is aborted and fails the test", async ({
  page,
}) => {
  await page.goto("/");

  const failed = page.waitForEvent(
    "requestfailed",
    (request) => request.url() === otherHost,
  );
  await page.evaluate((url) => fetch(url).catch(() => {}), otherHost);
  // This error is the guard's. Without the guard the request would fail too,
  // but with a name resolution error.
  expect((await failed).failure()?.errorText).toContain(
    "ERR_BLOCKED_BY_CLIENT",
  );

  // Everything above has passed, so from here on only the guard can fail
  // this test, when it checks for requests to other hosts after the body.
  // Expecting the failure makes Playwright report this test as passed only
  // if the guard does fail it.
  test.fail();
});

test("a redirect to another host fails the test", async ({ page }) => {
  // The app has no redirect to another host, so one is put in its place.
  // Sign-in and connecting a network will work through such redirects.
  await page.route("/redirect", (route) =>
    route.fulfill({ status: 302, headers: { location: otherHost } }),
  );
  await page.goto("/");

  const failed = page.waitForEvent(
    "requestfailed",
    (request) => request.url() === otherHost,
  );
  await page.evaluate(() => fetch("/redirect").catch(() => {}));
  // The browser has followed the redirect once this request has failed.
  await failed;

  // As above: only the guard can fail this test from here on.
  test.fail();
});

test("a redirect to another host is refused by the browser itself", async ({
  page,
}) => {
  // The fixture cannot abort a request that a redirect leads to, so the
  // resolver rule has to stop it. A host under ".invalid" cannot show that
  // it does: the machine's resolver would fail it with the same error. An
  // address can, because nothing ever looks it up. This one is the machine
  // itself, so it is as safe as ".invalid" if the rule is ever lost.
  const address = "http://127.0.0.1/";
  await page.route("/redirect", (route) =>
    route.fulfill({ status: 302, headers: { location: address } }),
  );
  await page.goto("/");

  const failed = page.waitForEvent(
    "requestfailed",
    (request) => request.url() === address,
  );
  await page.evaluate(() => fetch("/redirect").catch(() => {}));
  // Only the rule fails an address with a name resolution error. Without it
  // the browser would connect, and be answered or refused.
  expect((await failed).failure()?.errorText).toContain(
    "ERR_NAME_NOT_RESOLVED",
  );

  // As above: only the guard can fail this test from here on.
  test.fail();
});

test("a WebSocket to another host is closed unopened and fails the test", async ({
  page,
}) => {
  await page.goto("/");

  // Playwright reports a WebSocket here when the browser sets out to connect
  // it, which the guard must not let happen.
  const connecting: string[] = [];
  page.on("websocket", (webSocket) => connecting.push(webSocket.url()));

  const outcome = await page.evaluate(
    (url) =>
      new Promise<{ opened: boolean; code: number }>((resolve) => {
        const socket = new WebSocket(url);
        let opened = false;
        socket.onopen = () => {
          opened = true;
        };
        socket.onclose = ({ code }) => resolve({ opened, code });
      }),
    "wss://example.invalid/",
  );
  // 1008 is the guard's close code. Without the guard the socket would close
  // too, as the browser cannot resolve the host, but with code 1006. It must
  // not open first: the page would take a socket that leads nowhere for a
  // connection.
  expect(outcome).toEqual({ opened: false, code: 1008 });
  expect(connecting).toEqual([]);

  // As above: only the guard can fail this test from here on.
  test.fail();
});
