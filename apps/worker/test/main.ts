import type { Bindings } from "../src/env.ts";
import { providerOf } from "../src/network/providers.ts";
import { publishWorkflow } from "../src/publish/workflow.ts";
import { simWorldObject } from "../src/sim/object.ts";
import { workspaceObject } from "../src/workspace/object.ts";
import { clock, deployment } from "./clock.ts";

/**
 * What the tests run as the Worker, in place of src/index.ts: see `main` in
 * vitest.config.ts. It is the same Worker, except that what the runtime
 * constructs is built with what the test has: its Durable Objects with the
 * clock of the test, which a test can move, and the publishing workflow
 * with that clock, the `fetch` of the app of the test and its secrets. The
 * tests are in the same isolate, so they share this module with all three.
 */

export { default } from "../src/index.ts";

const now = () => clock.time;

/** The bindings of the runtime, without the secrets of this machine. */
function withoutSecrets({
  DB,
  VERSION,
  WORKSPACE,
  SIM_WORLD,
  PUBLISH,
}: Bindings): Bindings {
  return { DB, VERSION, WORKSPACE, SIM_WORLD, PUBLISH };
}

export class WorkspaceDO extends workspaceObject({ now }) {}

export class SimWorldDO extends simWorldObject({
  now,
  // A test that wants the development key deploys it as a secret.
  developmentBlueskyClientKeys: undefined,
}) {
  constructor(ctx: DurableObjectState, env: Bindings) {
    // With the secrets of the test, as the workflow below: the world of a
    // sandbox describes pigy with the keys that the app signs with.
    super(ctx, { ...withoutSecrets(env), ...deployment.secrets });
  }
}

export class PublishWorkflow extends publishWorkflow({
  fetch: (input, init) => deployment.fetch(input, init),
  now,
  // A test that wants the development keys deploys them as secrets.
  developmentCredentialKeys: undefined,
  developmentBlueskyClientKeys: undefined,
  providerOf: (...args) => (deployment.providerOf ?? providerOf)(...args),
  // A pause within a step is over at once: no test waits for one. What
  // was asked for is kept, for a test to look at.
  pause: async (milliseconds) => {
    deployment.pauses.push(milliseconds);
  },
}) {
  constructor(ctx: ExecutionContext, env: Bindings) {
    // The bindings of the runtime with the secrets of the test, and none
    // of this machine's: `setup()` does the same for the app.
    super(ctx, { ...withoutSecrets(env), ...deployment.secrets });
  }
}
