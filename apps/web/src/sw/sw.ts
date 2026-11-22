/// <reference lib="webworker" />
import type { Build } from "./build.ts";
import { activateMessage } from "./messages.ts";
import { precache } from "./precache.ts";
import { push } from "./push.ts";
import { indexedDbShares } from "./shares.ts";
import { workerPaths } from "./worker-paths.ts";

/**
 * The service worker of pigy. It makes the app start without a connection:
 * it keeps the app shell and the files of its build, and answers for them.
 * Everything else goes to the network untouched. And it shows the push
 * messages of the Worker as notifications, and takes the person who
 * presses one to the screen that it is about. What it does is in
 * precache.ts and push.ts, where it can be tested: this file only listens
 * to the browser.
 *
 * What is shared to pigy with files arrives here as a form that is
 * posted to `/share`: the files wait on the device for the share screen,
 * which the browser is sent on to. See shares.ts.
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
  shares: {
    store: indexedDbShares(indexedDB),
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
  },
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

const notifications = push({
  showNotification: (title, options) =>
    self.registration.showNotification(title, options),
  // Also the windows that this worker does not answer for yet.
  windows: async () => {
    const clients = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
    return clients.map((client) => ({
      url: client.url,
      focused: client.focused,
      visibilityState: client.visibilityState,
      focus: () => client.focus(),
      postMessage: (message, transfer) =>
        client.postMessage(message, transfer as Transferable[]),
    }));
  },
  openWindow: (url) => self.clients.openWindow(url),
  isWorkerPath: workerPaths(__BUILD__.workerFirst),
  reply: (milliseconds) => {
    const { port1, port2 } = new MessageChannel();
    const answered = new Promise<boolean>((resolve) => {
      const late = setTimeout(() => resolve(false), milliseconds);
      port1.onmessage = () => {
        clearTimeout(late);
        resolve(true);
      };
    });
    // Closed either way, so that nothing is left listening.
    void answered.then(() => port1.close());
    return { port: port2, answered };
  },
  now: () => Date.now(),
});

self.addEventListener("push", (event) => {
  let text: string | undefined;
  try {
    text = event.data?.text();
  } catch {
    // Shown in general words: something is always shown.
  }
  event.waitUntil(notifications.received(text));
});

// Not in the types of TypeScript, and not sent by every browser.
self.addEventListener("pushsubscriptionchange", (event) => {
  (event as ExtendableEvent).waitUntil(notifications.changed());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(notifications.clicked(event.notification.data));
});
