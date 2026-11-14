import { expect, it } from "vitest";

// Proves that test/setup.ts is loaded. Without it this request would not
// throw, and tests could depend on the network without anyone noticing.
it("blocks outbound requests made with the global fetch", async () => {
  await expect(fetch("https://example.com/")).rejects.toThrow(
    "Blocked outbound request to https://example.com/",
  );
});
