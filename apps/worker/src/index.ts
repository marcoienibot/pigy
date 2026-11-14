import { createApp } from "./app.ts";
import { createSimulatedGoogle } from "./simulated-google.ts";

const now = () => new Date();

// Vite replaces `import.meta.env.MODE` when it builds the Worker. The modes
// are listed rather than "not production", so that a build in a mode nobody
// thought of gets no simulated sign-in. In a production build the condition
// is a constant `false`, and the bundler drops the simulated Google with it:
// apps/web/scripts/check-build.mjs fails the build if it ever does not.
const simulated =
  import.meta.env.MODE === "development" ||
  import.meta.env.MODE === "test" ||
  import.meta.env.MODE === "e2e";

export default createApp({
  fetch: (input, init) => fetch(input, init),
  now,
  simulatedGoogle: simulated ? createSimulatedGoogle(now) : undefined,
});
