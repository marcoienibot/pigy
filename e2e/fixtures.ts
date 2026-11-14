import { test as base, expect } from "@playwright/test";

/**
 * The `test` that every spec imports, in place of the one from
 * "@playwright/test".
 *
 * Tests must never reach a real network host, so the browser may only talk
 * to the app itself. A request to any other origin is aborted, and the test
 * that made it fails once its body has run.
 */
export const test = base.extend<{ networkGuard: undefined }>({
  networkGuard: [
    async ({ context, baseURL }, use) => {
      if (!baseURL) throw new Error("baseURL is not set");
      const appOrigin = new URL(baseURL).origin;

      const strayRequests: string[] = [];
      // Recorded here and not in the route below, because routing does not
      // see where a redirect leads. Such a request cannot be aborted, but it
      // still fails the test.
      context.on("request", (request) => {
        const url = request.url();
        if (new URL(url).origin !== appOrigin) strayRequests.push(url);
      });
      await context.route(
        (url) => url.origin !== appOrigin,
        (route) => route.abort("blockedbyclient"),
      );

      await use(undefined);

      expect(
        strayRequests,
        "Requests to hosts other than the app. Tests must not use the network.",
      ).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
