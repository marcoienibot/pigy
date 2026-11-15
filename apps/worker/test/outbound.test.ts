import { expect, it } from "vitest";
import { outboundFetch } from "../src/outbound.ts";

// A host under the reserved ".invalid" domain: if a request ever left, it
// would reach nobody.
const address = "https://mastodon.example.invalid/api/v2/instance";

it("answers every request of the end-to-end build itself", async () => {
  const response = await outboundFetch("e2e")(address);

  // Answered here. Had the request gone on to the runtime's `fetch`, the
  // guard of test/setup.ts would have thrown. The status is what the
  // end-to-end tests recognize the guard by: e2e/tests/connect.spec.ts.
  expect(response.status).toBe(502);
  expect(await response.text()).toBe(`Blocked outbound request to ${address}`);
});

it.each(["production", "development", "test"])(
  "lets the requests of a %s build out",
  async (mode) => {
    // The runtime's `fetch` is what test/setup.ts has replaced, and only
    // that throws this: the request was on its way out.
    await expect(outboundFetch(mode)(address)).rejects.toThrow(
      `Blocked outbound request to ${address}. Tests must not use the network`,
    );
  },
);
