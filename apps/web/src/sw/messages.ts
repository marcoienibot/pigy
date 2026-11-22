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
 * screen there is to show. src/lib/service-worker.ts listens for it.
 *
 * The window that hears it is not always of the build of this worker. The
 * worker also tells windows that it does not answer for, and a window
 * stays on the version before while it holds changes that it could not
 * store. So nothing counts on the window understanding: it says that it
 * has heard, `navigatedMessage`, and the worker opens a window of its own
 * when no answer comes. Whoever changes this message changes it so that a
 * window of the version before does not take it for something else.
 */
export const navigateMessage = { type: "navigate" } as const;

/**
 * What a window answers to `navigateMessage`, on the port that came with
 * it: it has heard, and goes there. A window that does not answer in time
 * is one that cannot: a page that is still starting, a window of a version
 * of the app that does not know the message, one that is stuck, or one
 * that the browser has put aside. The service worker then opens a window
 * instead, where the browser still lets it.
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
