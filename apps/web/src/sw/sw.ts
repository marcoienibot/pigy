/// <reference lib="webworker" />
import type { Build } from "./build.ts";
import { activateMessage } from "./messages.ts";
import { precache } from "./precache.ts";

/**
 * The service worker of pigy. It makes the app start without a connection,
 * and that is all it does so far: it keeps the app shell and the files of
 * its build, and answers for them. Everything else goes to the network
 * untouched. What it does is in precache.ts, where it can be tested: this
 * file only listens to the browser. Phase 9 adds its listeners here, for
 * push messages and for what is shared to pigy.
 *
 * It is one file, /sw.js, built apart from the app: see
 * service-worker-plugin.ts.
 */
declare const self: ServiceWorkerGlobalScope;

/** Put in by the build. */
declare const __BUILD__: Build;

const app = precache(__BUILD__, {
  caches,
  fetch: (input, init) => fetch(input, init),
  origin: self.location.origin,
});

self.addEventListener("install", (event) => {
  // Installed, it waits: for the pages of the version before it to go, or
  // for one of them to send the message below. Taking over by itself would
  // put it in charge of pages that run another build.
  event.waitUntil(app.install());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    app
      .activate()
      // The pages that were loaded before there was a service worker: the
      // first one answers for them from here on.
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const answer = app.answer(event.request);
  // Not answering leaves the request to the browser, as if there were no
  // service worker.
  if (answer) event.respondWith(answer);
});

self.addEventListener("message", (event) => {
  if (event.data?.type === activateMessage.type) void self.skipWaiting();
});
