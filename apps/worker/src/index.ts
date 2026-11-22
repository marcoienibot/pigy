import { createApp } from "./app.ts";
import {
  developmentBlueskyClientKeys,
  developmentCredentialKeys,
} from "./development-keys.ts";
import { providerOf } from "./network/providers.ts";
import { outboundFetch } from "./outbound.ts";
import { publishWorkflow } from "./publish/workflow.ts";
import { simWorldObject } from "./sim/object.ts";
import { createSimulatedGoogle } from "./simulated-google.ts";
import { workspaceObject } from "./workspace/object.ts";

const now = () => new Date();

// Vite replaces `import.meta.env.MODE` when it builds the Worker. The modes
// are listed rather than "not production", so that a build in a mode nobody
// thought of gets no simulated sign-in and no development key. In a
// production build the condition is a constant `false`, and the bundler
// drops both with it: apps/web/scripts/check-build.mjs fails the build if it
// ever does not.
const simulated =
  import.meta.env.MODE === "development" ||
  import.meta.env.MODE === "test" ||
  import.meta.env.MODE === "e2e";

const dependencies = {
  fetch: outboundFetch(import.meta.env.MODE),
  now,
  simulatedGoogle: simulated ? createSimulatedGoogle(now) : undefined,
  developmentCredentialKeys: simulated ? developmentCredentialKeys : undefined,
  developmentBlueskyClientKeys: simulated
    ? developmentBlueskyClientKeys
    : undefined,
};

export default createApp(dependencies);

/**
 * The Durable Object of a workspace, under the name that wrangler.jsonc binds
 * as `WORKSPACE`. The runtime constructs it, so it is built here with what
 * it takes from outside, like the app above: what the workflow below is
 * built with too, because the object renews the access of its channels.
 */
export class WorkspaceDO extends workspaceObject({
  ...dependencies,
  providerOf,
}) {}

/**
 * The Durable Object of the simulated world of a sandbox workspace, bound as
 * `SIM_WORLD`. It is part of every build: the sandbox is a feature of the
 * app, not a tool for its development.
 */
export class SimWorldDO extends simWorldObject({
  now,
  developmentBlueskyClientKeys: dependencies.developmentBlueskyClientKeys,
}) {}

/**
 * The workflow that publishes a post to a channel, bound as `PUBLISH`. It
 * is built with what the app is built with: the same `fetch` leads to the
 * networks, and the same key opens what the routes sealed.
 */
export class PublishWorkflow extends publishWorkflow({
  ...dependencies,
  providerOf,
  pause: (milliseconds) => scheduler.wait(milliseconds),
}) {}
