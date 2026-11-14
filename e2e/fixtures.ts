import { randomUUID } from "node:crypto";
import {
  type BrowserContext,
  test as base,
  expect,
  type Page,
  type TestInfo,
} from "@playwright/test";

/**
 * The admin of the app under test. The e2e build has no configuration, so
 * this is the default admin of a build with simulated sign-in.
 */
export const adminEmail = "admin@example.com";

/**
 * An email address that no other test uses. The tests of both projects run
 * at the same time against one database, so an address that a test invites
 * or removes has to be its own.
 */
export function uniqueEmail(testInfo: TestInfo, name: string): string {
  return `${name}-${testInfo.project.name}-${randomUUID().slice(0, 8)}@example.com`;
}

/**
 * Goes through sign-in as `email`: from the sign-in page to the consent page
 * of the simulated Google and back into the app. It returns once the app has
 * answered, wherever that leads: for somebody who is not invited, that is
 * the invite-only page.
 */
export async function signIn(
  page: Page,
  email: string,
  { verified = true }: { verified?: boolean } = {},
): Promise<void> {
  // A test may be on the sign-in page already, with a place to return to in
  // its address.
  if (new URL(page.url()).pathname !== "/sign-in") await page.goto("/sign-in");
  await page.getByRole("link", { name: "Sign in with Google" }).click();
  await page.getByLabel("Email", { exact: true }).fill(email);
  if (!verified) {
    await page.getByLabel("Google has verified this email address").uncheck();
  }
  await page.getByRole("button", { name: "Continue" }).click();
  // Back in the app, past the Worker's callback.
  await page.waitForURL(
    ({ pathname }) =>
      !pathname.startsWith("/sim/") && !pathname.startsWith("/api/"),
  );
}

/**
 * Makes `context` unable to talk to anything but the app, and returns the
 * list that the requests it tried anyway are added to.
 */
async function guardNetwork(
  context: BrowserContext,
  appOrigin: string,
): Promise<string[]> {
  // The app's origin as the URL of a WebSocket spells it: "ws" for "http"
  // and "wss" for "https".
  const appWebSocketOrigin = appOrigin.replace(/^http/, "ws");

  const strayRequests: string[] = [];
  // Recorded here and not in the route below, because routing does not see
  // where a redirect leads. Such a request is not aborted here: the resolver
  // rule in playwright.config.ts is what stops it.
  context.on("request", (request) => {
    const url = request.url();
    if (new URL(url).origin !== appOrigin) strayRequests.push(url);
  });
  await context.route(
    (url) => url.origin !== appOrigin,
    (route) => route.abort("blockedbyclient"),
  );
  // WebSockets go through neither of the above. A routed WebSocket connects
  // to its server only if the handler asks for that, so closing it is all it
  // takes to block it. 1008 is the close code for a broken policy.
  await context.routeWebSocket(
    (url) => url.origin !== appWebSocketOrigin,
    (webSocket) => {
      strayRequests.push(webSocket.url());
      return webSocket.close({
        code: 1008,
        reason: "Tests must not use the network.",
      });
    },
  );
  return strayRequests;
}

/**
 * The `test` that every spec imports, in place of the one from
 * "@playwright/test".
 *
 * Tests must never reach a real network host, so the browser may only talk
 * to the app itself. A request or a WebSocket to any other origin is blocked,
 * and the test that made it fails once its body has run.
 */
export const test = base.extend<{
  networkGuard: undefined;
  /** `page`, signed in as the admin. For tests that are not about sign-in. */
  signedInPage: Page;
  /**
   * Opens a page in a browser of its own, for a second person: it shares no
   * cookies with `page`. Guarded like `page`, and closed after the test.
   */
  newPerson: () => Promise<Page>;
}>({
  networkGuard: [
    async ({ context, baseURL }, use) => {
      if (!baseURL) throw new Error("baseURL is not set");
      const strayRequests = await guardNetwork(
        context,
        new URL(baseURL).origin,
      );

      await use(undefined);

      expect(
        strayRequests,
        "Requests to hosts other than the app. Tests must not use the network.",
      ).toEqual([]);
    },
    { auto: true },
  ],

  signedInPage: async ({ page }, use) => {
    await signIn(page, adminEmail);
    // The app shell is only there for somebody who is signed in.
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
    await use(page);
  },

  newPerson: async (
    {
      browser,
      baseURL,
      viewport,
      userAgent,
      deviceScaleFactor,
      isMobile,
      hasTouch,
    },
    use,
  ) => {
    if (!baseURL) throw new Error("baseURL is not set");
    const contexts: BrowserContext[] = [];
    const strayRequests: string[][] = [];

    await use(async () => {
      // On the same device as `page`, which is what the project sets these
      // to.
      const context = await browser.newContext({
        baseURL,
        viewport,
        isMobile,
        hasTouch,
        ...(userAgent !== undefined && { userAgent }),
        ...(deviceScaleFactor !== undefined && { deviceScaleFactor }),
      });
      contexts.push(context);
      strayRequests.push(await guardNetwork(context, new URL(baseURL).origin));
      return context.newPage();
    });

    for (const context of contexts) await context.close();
    expect(
      strayRequests.flat(),
      "Requests to hosts other than the app. Tests must not use the network.",
    ).toEqual([]);
  },
});

export { expect };
