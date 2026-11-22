import { serviceWorkerAnswersFor } from "../app.ts";
import { expect, test } from "../fixtures.ts";

// These tests prove the guard, which is the fixture in fixtures.ts and the
// resolver rule in playwright.config.ts, by breaking its rule. Their host is
// under the reserved ".invalid" domain or is this machine: if the guard ever
// stops working, the requests still cannot reach a real host.
const otherHost = "https://example.invalid/";

// The content security policy of the app refuses a request to another host
// before the guard sees it: `connect-src 'self'`. That is the app keeping
// its own rule, which security-headers.spec.ts tests. These tests are about
// the guard behind it, for what the policy does not cover or would let
// through if it were ever widened, so their pages are not under the policy.
test.use({ bypassCSP: true });

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

test("a request to another host is aborted when the service worker answers for the page", async ({
  page,
}) => {
  await page.goto("/");
  // From here on the requests of the page go to the service worker of the
  // app first. It leaves this one to the browser, where the guard is: a
  // worker that fetched it by itself would be the next test's business.
  await serviceWorkerAnswersFor(page);

  const failed = page.waitForEvent(
    "requestfailed",
    (request) => request.url() === otherHost,
  );
  await page.evaluate((url) => fetch(url).catch(() => {}), otherHost);
  expect((await failed).failure()?.errorText).toContain(
    "ERR_BLOCKED_BY_CLIENT",
  );

  // As above: only the guard can fail this test from here on.
  test.fail();
});

test("a request of the service worker to another host is aborted and fails the test", async ({
  page,
  context,
}) => {
  // A service worker has the policy that its script came with, which
  // `bypassCSP` does not lift. The script is passed on as it is, without
  // that one header.
  await context.route("**/sw.js", async (route) => {
    const response = await route.fetch();
    const { "content-security-policy": _, ...headers } = response.headers();
    await route.fulfill({ response, headers });
  });
  await page.goto("/");
  await serviceWorkerAnswersFor(page);
  const [worker] = context.serviceWorkers();
  if (!worker) throw new Error("The app has no service worker");

  // The service worker of the app asks nothing of other hosts, so the test
  // makes it. The request is not a page's: the guard has to see it all the
  // same, and stop it.
  const failed = context.waitForEvent(
    "requestfailed",
    (request) => request.url() === otherHost,
  );
  const outcome = await worker.evaluate(
    (url) =>
      fetch(url).then(
        () => "answered",
        () => "failed",
      ),
    otherHost,
  );
  expect(outcome).toBe("failed");
  const request = await failed;
  expect(request.serviceWorker()).toBe(worker);
  expect(request.failure()?.errorText).toContain("ERR_BLOCKED_BY_CLIENT");

  // As above: only the guard can fail this test from here on.
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
