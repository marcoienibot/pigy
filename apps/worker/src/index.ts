import { createApp } from "./app.ts";
import { createSimulatedGoogle } from "./simulated-google.ts";
import { workspaceObject } from "./workspace/object.ts";

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

/**
 * The Durable Object of a workspace, under the name that wrangler.jsonc binds
 * as `WORKSPACE`. The runtime constructs it, so it is built here with what
 * it takes from outside, like the app above.
 */
export class WorkspaceDO extends workspaceObject({ now }) {}
