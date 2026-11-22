import { z } from "zod";

// Zod as the page and the deployed Worker run it: without compiling its
// schemas into functions, which the content security policy of the app
// refuses, and the Workers runtime too. apps/web/zod-without-eval.ts has
// why the builds tell it so. Node lets it compile, so without this the
// tests would check what the app checks in another way than the app.
z.config({ jitless: true });

// Tests must never reach a real network host. Code that talks to external
// services takes `fetch` as a parameter, so any call to the global `fetch`
// during a test is a bug and fails loudly here.
globalThis.fetch = async (input) => {
  const url = input instanceof Request ? input.url : String(input);
  throw new Error(
    `Blocked outbound request to ${url}. Tests must not use the network: pass a fetch to the code under test instead.`,
  );
};
