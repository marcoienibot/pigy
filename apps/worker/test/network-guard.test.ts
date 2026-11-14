import { connect } from "cloudflare:sockets";
import { expect, it } from "vitest";
import { runtimeFetch } from "./runtime-fetch.ts";

// Proves that test/setup.ts is loaded. Without it this request would not
// throw, and tests could depend on the network without anyone noticing.
it("blocks outbound requests made with the global fetch", async () => {
  await expect(fetch("https://example.com/")).rejects.toThrow(
    "Blocked outbound request to https://example.com/",
  );
});

// The tests below prove the second layer, test/deny-outbound.js, by going
// around the first one. Their hosts are under the reserved ".invalid" domain:
// if the second layer ever stops working, they fail without reaching a real
// host.

it("blocks outbound requests that get past the global fetch guard", async () => {
  const response = await runtimeFetch("https://api.example.invalid/posts");

  // Only test/deny-outbound.js answers like this. Without it the request
  // would fail to resolve the host instead.
  expect(response.status).toBe(502);
  expect(await response.text()).toBe(
    "Blocked outbound request to https://api.example.invalid/posts",
  );
});

it("blocks outbound TCP connections", async () => {
  // The app never opens TCP sockets, but a dependency could, and the guard
  // on the global `fetch` does not see them.
  const socket = connect({ hostname: "db.example.invalid", port: 5432 });

  // Reading this text means that test/deny-outbound.js took the connection.
  expect(await new Response(socket.readable).text()).toBe(
    "Blocked outbound connection",
  );
});
