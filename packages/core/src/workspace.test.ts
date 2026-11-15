import { expect, it } from "vitest";
import { type Workspace, workspaceToShow } from "./workspace.ts";

const live: Workspace = { id: "live-1", environment: "live" };
const sandbox: Workspace = { id: "sandbox-1", environment: "sandbox" };
// In the order in which the server lists them: the sandbox is not shown
// for being first.
const workspaces = [live, sandbox];

it("shows the sandbox to somebody who has never chosen", () => {
  expect(workspaceToShow(workspaces, [])).toBe(sandbox);
  // What a browser hands out for a key that it does not have.
  expect(workspaceToShow(workspaces, [null, undefined])).toBe(sandbox);
});

it("shows the workspace that was chosen", () => {
  expect(workspaceToShow(workspaces, [live.id])).toBe(live);
  expect(workspaceToShow(workspaces, [sandbox.id])).toBe(sandbox);
});

it("goes by the first choice, and by the next one where there is none", () => {
  // The choice of a tab, then that of the device.
  expect(workspaceToShow(workspaces, [sandbox.id, live.id])).toBe(sandbox);
  expect(workspaceToShow(workspaces, [null, live.id])).toBe(live);
});

it("passes over a choice that names no workspace of the person", () => {
  // Left on the device by somebody else: their live workspace must not
  // make this person start in theirs.
  expect(workspaceToShow(workspaces, ["live-of-another", live.id])).toBe(live);
  expect(workspaceToShow(workspaces, ["live-of-another"])).toBe(sandbox);
});

it("shows nothing to a person without workspaces", () => {
  expect(workspaceToShow([], [live.id])).toBeUndefined();
});
