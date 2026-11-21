import { expect, it } from "vitest";
import { askToKeep, type DeviceStorage, keptBy } from "./device-storage.ts";

// What pigy asks of the browser about keeping its data, and what it makes
// of the answers. The browser of the end-to-end tests gives one answer:
// the others are here.

/** A browser that has `promised` and answers a request with `grants`. */
function browser(promised: boolean, grants: boolean) {
  const calls: string[] = [];
  const storage: DeviceStorage = {
    async persisted() {
      calls.push("persisted");
      return promised;
    },
    async persist() {
      calls.push("persist");
      return grants;
    },
  };
  return { storage, calls };
}

it("asks a browser that has not promised, and says what it answers", async () => {
  expect(await askToKeep(browser(false, true).storage)).toBe("kept");
  expect(await askToKeep(browser(false, false).storage)).toBe("not-kept");
});

it("does not ask a browser again that has promised", async () => {
  const { storage, calls } = browser(true, false);

  expect(await askToKeep(storage)).toBe("kept");
  // A browser that asks the person would ask them for what they gave.
  expect(calls).toEqual(["persisted"]);
});

it("asks for nothing when it only reads the answer", async () => {
  const { storage, calls } = browser(false, true);

  expect(await keptBy(storage)).toBe("not-kept");
  expect(calls).toEqual(["persisted"]);
});

it.each([
  // An address that is not served securely.
  ["has no storage manager", undefined],
  // Browsers from before the promise existed.
  ["has a storage manager without the promise", {}],
])(
  "says that it does not know in a browser that %s",
  async (_name, storage) => {
    expect(await keptBy(storage)).toBe("unknown");
    expect(await askToKeep(storage)).toBe("unknown");
  },
);

it("takes a browser that fails to answer for one that has not promised", async () => {
  // A browser may refuse the question outright, as for a page in a frame.
  const storage: DeviceStorage = {
    persisted: async () => false,
    persist: () =>
      Promise.reject(new DOMException("Not here", "SecurityError")),
  };

  expect(await askToKeep(storage)).toBe("not-kept");
});
