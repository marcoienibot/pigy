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

export class WorkspaceDO extends workspaceObject({ now }) {}

export class SimWorldDO extends simWorldObject({ now }) {}

export class PublishWorkflow extends publishWorkflow({
  fetch: (input, init) => deployment.fetch(input, init),
  now,
  // A test that wants the development key deploys it as a secret.
  developmentCredentialKeys: undefined,
  providerOf: (...args) => (deployment.providerOf ?? providerOf)(...args),
}) {
  constructor(ctx: ExecutionContext, env: Bindings) {
    // The bindings of the runtime with the secrets of the test, and none
    // of this machine's: `setup()` does the same for the app.
    const { DB, VERSION, WORKSPACE, SIM_WORLD, PUBLISH } = env;
    super(ctx, {
      DB,
      VERSION,
      WORKSPACE,
      SIM_WORLD,
      PUBLISH,
      ...deployment.secrets,
    });
  }
}
