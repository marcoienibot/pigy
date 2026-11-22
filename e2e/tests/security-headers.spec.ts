import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  channelRows,
  feedOf,
  grace,
  openConsentPage,
  openScreen,
  publishDraft,
  sentPost,
  serviceWorkerAnswersFor,
} from "../app.ts";
import { expect, type Page, test } from "../fixtures.ts";

// The content security policy and the other headers of the built app.
//
// Every test of this directory is a test of the policy: the `test` of
// fixtures.ts fails one whose pages did what the policy refuses, on
// whatever screen. What is here is what that cannot show: that the policy
// is there at all, on every screen, and what it and the other headers say.

/**
 * The address of every screen of the app, read from the list that the
 * router is built from: a screen that is added is tested here without
 * anybody thinking of it.
 */
function screens(): string[] {
  const routes = readFileSync(
    new URL("../../apps/web/src/routeTree.gen.ts", import.meta.url),
    "utf8",
  );
  const paths = new Set(
    [...routes.matchAll(/fullPath: '([^']+)'/g)].flatMap(([, path]) =>
      path ? [path] : [],
    ),
  );
  // The route for every address that is no screen: an address of its own
  // stands for it.
  paths.delete("/$");
  paths.add("/no-such-screen");
  return [...paths].sort();
}

/**
 * Does on `page` what the policy must refuse: a script that is written
 * into the page, as somebody would who got text of theirs into it. Returns
 * whether it ran.
 */
function injectScript(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const script = document.createElement("script");
    script.textContent = "window.pigyInjected = true";
    document.head.append(script);
    return "pigyInjected" in window;
  });
}

test("every screen is under the policy, and does nothing that it refuses", async ({
  ownPage: page,
  policyViolations,
}) => {
  const paths = screens();
  // Otherwise the loop below would pass without looking at anything.
  expect(paths).toContain("/queue/calendar");
  expect(paths).toContain("/sign-in");

  for (const path of paths) {
    await page.goto(path);
    // The screen is drawn: its scripts and its style sheet were let
    // through, or there would be nothing in the page.
    await expect(page.locator("#root > *").first(), path).toBeVisible();
    // Where the app has left the person, which for some addresses is
    // another screen.
    const { pathname } = new URL(page.url());
    // Nothing that the screen did by itself was refused.
    expect(policyViolations, path).toEqual([]);

    // And the policy is in force here: without it, the list above is
    // empty whatever the screen does.
    expect(await injectScript(page), path).toBe(false);
    await expect
      .poll(() => policyViolations, { message: path })
      .toEqual([`script-src-elem refused inline on ${pathname}`]);
    // The violation of the test's own, which must not fail it.
    policyViolations.length = 0;
  }
});

test("the screens of somebody who is not signed in are under the policy", async ({
  page,
  policyViolations,
}) => {
  for (const path of ["/sign-in", "/invite-only", "/sign-in?error=failed"]) {
    await page.goto(path);
    await expect(page.locator("#root > *").first(), path).toBeVisible();
    expect(policyViolations, path).toEqual([]);

    expect(await injectScript(page), path).toBe(false);
    await expect
      .poll(() => policyViolations, { message: path })
      .toEqual([
        `script-src-elem refused inline on ${new URL(page.url()).pathname}`,
      ]);
    policyViolations.length = 0;
  }
});

test("the policy holds for a page that the service worker answers from the device", async ({
  signedInPage: page,
  policyViolations,
}) => {
  await serviceWorkerAnswersFor(page);

  const response = await page.goto("/queue");

  // The app shell as the service worker kept it, with the headers that it
  // came with: a page from the device is no less guarded than one from
  // the server.
  expect(response?.fromServiceWorker()).toBe(true);
  expect(response?.headers()["content-security-policy"]).toContain(
    "default-src 'none'",
  );
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Queue");
  expect(await injectScript(page)).toBe(false);
  await expect
    .poll(() => policyViolations)
    .toEqual(["script-src-elem refused inline on /queue"]);
  policyViolations.length = 0;
});

test("the script that sets the theme is allowed by its hash, and runs before the app", async ({
  page,
  request,
}) => {
  const response = await request.get("/sign-in");
  const html = await response.text();
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  // One script is written into the page, AGENTS.md, "Rules".
  expect(inline).toHaveLength(1);
  const digest = createHash("sha256")
    .update(inline[0]?.[1] ?? "")
    .digest("base64");

  // The hash in the header is the one of the script as it was served: the
  // build wrote it, security-headers-plugin.ts.
  expect(response.headers()["content-security-policy"]).toContain(
    `script-src 'self' 'sha256-${digest}';`,
  );

  // And the browser lets it run. The scripts of the app are held back, so
  // that only the inline one can have set the theme.
  await page.route("**/assets/*.js", (route) => route.abort());
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/sign-in");
  await expect(page.locator("html")).toContainClass("dark");
});

test("the app shell says what a browser may do with it", async ({
  request,
}) => {
  const shell = (await request.get("/queue")).headers();

  expect(shell["content-security-policy"]).toMatch(
    /^default-src 'none'; script-src 'self' 'sha256-[A-Za-z0-9+/]+='; style-src 'self' ('sha256-[A-Za-z0-9+/]+=' ?)+; img-src 'self' https:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'$/,
  );
  // Nothing is allowed wholesale, and no placeholder of the build is left.
  expect(shell["content-security-policy"]).not.toContain("unsafe");
  expect(shell["content-security-policy"]).not.toContain("{{");
  expect(shell["x-content-type-options"]).toBe("nosniff");
  // Not at a local address: a browser would remember it for `localhost`.
  // A file has it at no address, and the Worker at a deployed one.
  expect(shell["strict-transport-security"]).toBeUndefined();

  // The Worker says the same of its own answers, in another place:
  // apps/worker/src/security-headers.ts. The two must not drift apart.
  const api = (await request.get("/api/health")).headers();
  for (const name of [
    "x-content-type-options",
    "referrer-policy",
    "cross-origin-opener-policy",
    "permissions-policy",
  ]) {
    expect(shell[name], name).toBeTruthy();
    expect(api[name], name).toBe(shell[name]);
  }
  expect(api["content-security-policy"]).toBe(
    "default-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
  expect(api["strict-transport-security"]).toBeUndefined();
});

test("connecting an account through a consent page, publishing and the simulator stay within the policy", async ({
  ownPage: page,
  policyViolations,
}) => {
  await openScreen(page, "Channels");
  const consent = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.startsWith("/sim/network/") &&
      response.request().method() === "GET",
  );
  await openConsentPage(page);

  // The page of a simulated network has a policy of its own: no script,
  // and its one style sheet by its hash.
  expect((await consent).headers()["content-security-policy"]).toMatch(
    /^default-src 'none'; style-src 'sha256-[A-Za-z0-9+/]+='; form-action 'self'; base-uri 'none'; frame-ancestors 'none'$/,
  );
  // The hash is right: the style sheet is applied. A browser that
  // refused it would draw the notice without its border.
  await expect(page.locator(".notice")).toHaveCSS("border-top-style", "dashed");
  expect(await injectScript(page)).toBe(false);
  await expect.poll(() => policyViolations).toHaveLength(1);
  policyViolations.length = 0;

  // The form is sent, and the redirect that answers it is followed, back
  // into the app: `form-action` is asked about both.
  await page.getByRole("button", { name: grace }).click();
  await expect(channelRows(page).filter({ hasText: grace })).toBeVisible();

  await openScreen(page, "Drafts");
  await publishDraft(page, "Within the policy", grace);
  // The notice of the notice library, whose style sheet the policy
  // allows by its hash: it is laid out by it, in a corner of the window
  // and not in the flow of the page.
  await expect(page.locator("[data-sonner-toaster]")).toHaveCSS(
    "position",
    "fixed",
  );
  await openScreen(page, "Sent");
  await expect(sentPost(page, "Within the policy")).toBeVisible();
  await openScreen(page, "Simulator");
  await expect(feedOf(page, grace)).toContainText("Within the policy");
  // What the fixture checks when the test is over: nothing on the way was
  // refused.
});
