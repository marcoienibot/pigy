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
