/**
 * What a page says to a service worker that is installed and waiting: take
 * over now. The page that says so, and every other page of the app, loads
 * itself again when the worker has: see src/lib/service-worker.ts.
 */
export const activateMessage = { type: "activate" } as const;
