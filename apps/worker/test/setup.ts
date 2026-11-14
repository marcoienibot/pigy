import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";
// Imported for its side effect: it keeps the runtime's own `fetch` for
// network-guard.test.ts before the global is replaced below.
import "./runtime-fetch.ts";

// Tests must never reach a real network host. Code that talks to external
// services takes `fetch` as a parameter, so any call to the global `fetch`
// during a test is a bug and fails loudly here.
globalThis.fetch = async (input) => {
  const url = input instanceof Request ? input.url : String(input);
  throw new Error(
    `Blocked outbound request to ${url}. Tests must not use the network: pass a fetch to the code under test instead.`,
  );
};

// Every test starts with an empty database that has the current schema.
// Storage is only separate per test file, so without this a test would see
// what the tests before it in the same file left behind.
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
