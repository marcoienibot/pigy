import { expect, it } from "vitest";

// Proves that test/setup.ts is loaded. Without it this request would not be
// stopped here, and tests could depend on the network without anyone
// noticing. The host is under the reserved ".invalid" domain: nothing stands
// behind this guard in Node, so if it ever stops working, the request still
// cannot reach a real host.
it("blocks outbound requests made with the global fetch", async () => {
  await expect(fetch("https://example.invalid/")).rejects.toThrow(
    "Blocked outbound request to https://example.invalid/",
  );
});
