import {
  applyD1Migrations,
  evictAllDurableObjects,
  reset,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";
// Imported for its side effect: it keeps the runtime's own `fetch` for
// network-guard.test.ts before the global is replaced below.
import "./runtime-fetch.ts";

// Zod compiles no schema into a function here, as in a deployed Worker and
// on a page of the app: it knows the Workers runtime by its user agent and
// does not try `new Function` there, which the runtime of these tests would
// allow. The tests that run in Node tell it so in their setup.

// Tests must never reach a real network host. Code that talks to external
// services takes `fetch` as a parameter, so any call to the global `fetch`
// during a test is a bug and fails loudly here.
globalThis.fetch = async (input) => {
  const url = input instanceof Request ? input.url : String(input);
  throw new Error(
    `Blocked outbound request to ${url}. Tests must not use the network: pass a fetch to the code under test instead.`,
  );
};

// Every test starts with an empty database that has the current schema, and
// with no workspace objects. Storage is only separate per test file, so
// without this a test would see what the tests before it in the same file
// left behind.
beforeEach(async () => {
  // First the sockets that the test before left open, and those that a
  // workspace was still closing when the test ended. Deleting an object
  // from under them makes the runtime log an exception for each.
  await evictAllDurableObjects({ webSockets: "close" });
  await emptied();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

/**
 * Deletes what the test before has stored, and makes sure that it is
 * gone. `reset()` does not always delete: now and then, on a machine
 * under load, it returns and everything is still there, the database and
 * the objects with it. The next test then signs in to the workspaces of
 * the one before, with their posts, their deliveries and their clock,
 * and fails in ways that have nothing to do with what it tests. A second
 * `reset()` a moment later does delete. So this asks the database
 * whether it is empty, which it is not while it has the tables of the
 * migrations, and tries again until it is.
 */
async function emptied(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    await reset();
    const left = await env.DB.prepare(
      "select count(*) as tables from sqlite_master where type = 'table' and name = 'workspace'",
    ).first<{ tables: number }>();
    if (!left?.tables) return;
    if (attempt === 50) {
      throw new Error("The storage of the test before could not be deleted");
    }
    await evictAllDurableObjects({ webSockets: "close" });
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
