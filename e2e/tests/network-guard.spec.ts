import { expect, test } from "../fixtures.ts";

// Both tests prove the guard in fixtures.ts by breaking its rule. Their host
// is under the reserved ".invalid" domain: if the guard ever stops working,
// the requests still cannot reach a real host.
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
