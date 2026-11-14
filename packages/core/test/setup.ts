// Tests must never reach a real network host. Code that talks to external
// services takes `fetch` as a parameter, so any call to the global `fetch`
// during a test is a bug and fails loudly here.
globalThis.fetch = async (input) => {
  const url = input instanceof Request ? input.url : String(input);
  throw new Error(
    `Blocked outbound request to ${url}. Tests must not use the network: pass a fetch to the code under test instead.`,
  );
};
