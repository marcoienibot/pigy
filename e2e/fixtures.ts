import { randomUUID } from "node:crypto";
import {
  type Browser,
  type BrowserContext,
  test as base,
  expect,
  type Page,
  type Route,
  type TestInfo,
  type WebSocketRoute,
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
 * Puts `email` on the allowlist, as the admin, in a browser of its own.
 * The invitation goes straight to the API: the screen for it has its own
 * tests.
 */
async function invite(
  browser: Browser,
  baseURL: string,
  email: string,
): Promise<void> {
  // Without a service worker, which this browser would install only to be
  // closed: it signs in and makes one request.
  const context = await browser.newContext({
    baseURL,
    serviceWorkers: "block",
  });
  try {
    const strayRequests = await guardNetwork(context, new URL(baseURL).origin);
    const page = await context.newPage();
    await signIn(page, adminEmail);
    const response = await page.request.post("/api/admin/allowed-emails", {
      data: { email, role: "member" },
      // What a page of the app sends with a request that changes something.
      headers: { Origin: new URL(baseURL).origin },
    });
    expect(response.status()).toBe(204);
    expect(strayRequests).toEqual([]);
  } finally {
    await context.close();
  }
}

/**
 * Signs `context` in as `email` without loading a page in it: the sign-in
 * happens in a browser of its own, and `context` is handed the session.
 */
async function signInElsewhere(
  browser: Browser,
  baseURL: string,
  context: BrowserContext,
  email: string,
): Promise<void> {
  // Without a service worker, as in `invite`.
  const elsewhere = await browser.newContext({
    baseURL,
    serviceWorkers: "block",
  });
  try {
    const strayRequests = await guardNetwork(
      elsewhere,
      new URL(baseURL).origin,
    );
    const page = await elsewhere.newPage();
    await signIn(page, email);
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
    await context.addCookies(await elsewhere.cookies());
    expect(strayRequests).toEqual([]);
  } finally {
    await elsewhere.close();
  }
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
 * and the test that made it fails once its body has run. That goes for the
 * service worker of the app as for its pages: the requests of both are
 * requests of the browser context, which is what is guarded.
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
  /**
   * The address of somebody who is invited for this test alone. Their
   * workspace is empty and no other test touches it, which the workspace of
   * the admin is not: all tests share that one.
   */
  ownEmail: string;
  /** `page`, signed in as `ownEmail`, on the drafts screen. */
  ownPage: Page;
  /**
   * Opens the app on another device of the same person: a browser of its
   * own, signed in as `ownEmail`.
   */
  otherDevice: () => Promise<Page>;
  /**
   * Signs the browser of `page` in as `email` before it has loaded a page
   * of the app. For a test that decides what the first page load of its
   * browser gets, such as its first service worker.
   */
  signInBeforeFirstLoad: (email: string) => Promise<void>;
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

  ownEmail: async ({ browser, baseURL }, use, testInfo) => {
    if (!baseURL) throw new Error("baseURL is not set");
    const email = uniqueEmail(testInfo, "writer");
    await invite(browser, baseURL, email);
    await use(email);
  },

  ownPage: async ({ page, ownEmail }, use) => {
    await signIn(page, ownEmail);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Drafts");
    await use(page);
  },

  otherDevice: async ({ newPerson, ownEmail }, use) => {
    await use(async () => {
      const page = await newPerson();
      await signIn(page, ownEmail);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        "Drafts",
      );
      return page;
    });
  },

  signInBeforeFirstLoad: async ({ browser, baseURL, context }, use) => {
    if (!baseURL) throw new Error("baseURL is not set");
    await use((email) => signInElsewhere(browser, baseURL, context, email));
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

export { expect, type Page, type Route, type WebSocketRoute };
