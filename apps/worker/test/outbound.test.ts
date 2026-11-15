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

it("fails as a fetch does that got no answer, whatever the runtime fails with", async () => {
  // The guard of test/setup.ts stands in for the runtime here. It fails as
  // the Workers runtime does when a connection is refused or lost: with a
  // plain error.
  const guard = await fetch(address).catch((error: unknown) => error);
  expect(guard).not.toBeInstanceOf(TypeError);

  const error = await outboundFetch("production")(address).catch(
    (thrown: unknown) => thrown,
  );

  // A TypeError is what the adapters take for a network out of reach.
  // Anything else they pass on as a bug.
  expect(error).toBeInstanceOf(TypeError);
  expect(error).toMatchObject({ cause: guard });
});

it("leaves a request that its own signal ended to fail with what the signal says", async () => {
  const signal = AbortSignal.abort(new Error("The time is up"));

  const error = await outboundFetch("production")(address, { signal }).catch(
    (thrown: unknown) => thrown,
  );

  // The guard does not look at the signal, so the failure is still its
  // own. What counts is that it comes as it is, and not as the failure of
  // a network: `send` of @pigy/providers goes by the signal.
  expect(error).not.toBeInstanceOf(TypeError);
  expect(error).toMatchObject({
    message: expect.stringContaining("Blocked outbound request"),
  });
});
