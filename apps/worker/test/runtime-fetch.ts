/**
 * The runtime's own `fetch`, captured before test/setup.ts replaces the
 * global one. It exists only for network-guard.test.ts, to prove that a
 * request that gets past the guard in test/setup.ts is still blocked. Do not
 * import it anywhere else.
 */
export const runtimeFetch = globalThis.fetch;
