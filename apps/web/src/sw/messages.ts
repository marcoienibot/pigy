/**
 * What a page says to a service worker that is installed and waiting: take
 * over now. The page that says so, and every other page of the app, loads
 * itself again when the worker has: see src/lib/service-worker.ts.
 *
 * A contract between the versions of the app, which must not change: the
 * page that says it runs the version before the worker's, whatever version
 * that is. A worker that listened for something else would not hear the
 * pages of the versions before it, and would take over only when the last
 * window of the app has been closed.
 */
export const activateMessage = { type: "activate" } as const;

/**
 * What the service worker says to a window of the app when the person has
 * pressed a notification: go to `url`, a path of the app with what the
 * screen there is to show. src/lib/service-worker.ts listens for it. The
 * windows of the app run the build of the worker that answers for them,
 * so the two change together.
 */
export const navigateMessage = { type: "navigate" } as const;

/**
 * What a window answers to `navigateMessage`, on the port that came with
 * it: it has heard, and goes there. A window that does not answer is one
 * that cannot: a page that is still starting, or one of the same address
 * that is not the app. The service worker then opens a window instead.
 */
export const navigatedMessage = { type: "navigated" } as const;

/**
 * What the service worker says to the windows of the app when the browser
 * has replaced the push subscription of the device, or taken it away: the
 * browser tells the worker alone. A window hands the server the new one,
 * `renewNotifications` of src/lib/notifications.ts: it has the session
 * that the notifications were turned on in, which the worker has not.
 */
export const subscriptionChangedMessage = {
  type: "subscription-changed",
} as const;
