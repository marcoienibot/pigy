import { test as base, expect } from "@playwright/test";

/**
 * The `test` that every spec imports, in place of the one from
 * "@playwright/test".
 *
 * Tests must never reach a real network host, so the browser may only talk
 * to the app itself. A request or a WebSocket to any other origin is blocked,
 * and the test that made it fails once its body has run.
 */
export const test = base.extend<{ networkGuard: undefined }>({
  networkGuard: [
    async ({ context, baseURL }, use) => {
      if (!baseURL) throw new Error("baseURL is not set");
      const appOrigin = new URL(baseURL).origin;
      // The app's origin as the URL of a WebSocket spells it: "ws" for
      // "http" and "wss" for "https".
      const appWebSocketOrigin = appOrigin.replace(/^http/, "ws");

      const strayRequests: string[] = [];
      // Recorded here and not in the route below, because routing does not
      // see where a redirect leads. Such a request is not aborted here: the
      // resolver rule in playwright.config.ts is what stops it.
      context.on("request", (request) => {
        const url = request.url();
        if (new URL(url).origin !== appOrigin) strayRequests.push(url);
      });
      await context.route(
        (url) => url.origin !== appOrigin,
        (route) => route.abort("blockedbyclient"),
      );
      // WebSockets go through neither of the above. A routed WebSocket
      // connects to its server only if the handler asks for that, so closing
      // it is all it takes to block it. 1008 is the close code for a broken
      // policy.
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
