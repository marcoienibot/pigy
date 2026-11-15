import { simWorldObject } from "../src/sim/object.ts";
import { workspaceObject } from "../src/workspace/object.ts";
import { clock } from "./clock.ts";

/**
 * What the tests run as the Worker, in place of src/index.ts: see `main` in
 * vitest.config.ts. It is the same Worker, except that its Durable Objects
 * are built with the clock of the test, which a test can move. The tests are
 * in the same isolate, so they share this module with the objects.
 */

export { default } from "../src/index.ts";

const now = () => clock.time;

export class WorkspaceDO extends workspaceObject({ now }) {}

export class SimWorldDO extends simWorldObject({ now }) {}
