import { type Environment, type Workspace, workspaceToShow } from "@pigy/core";
import { useRouteContext, useRouter } from "@tanstack/react-router";
import { useCallback } from "react";
import { toast } from "sonner";
import { workspaceSync } from "@/sync/workspace-sync";

/**
 * Which of the person's two workspaces the app shows: live, which posts to
 * the real networks, or the sandbox, where the networks are simulated.
 *
 * The choice belongs to the tab. What a tab shows changes when the person
 * changes it in that tab, and at no other time: a tab that followed the
 * choice made in another one would turn from sandbox to live behind the
 * back of whoever comes back to it, and what they then tried there would
 * go out for real. It also lets the two be open side by side.
 *
 * The device remembers the choice that was made last, for the next tab
 * and the next time the app is opened. So there are two places:
 *
 * - `sessionStorage`, which is the tab's own and lasts over a reload and
 *   over the way to a network and back.
 * - `localStorage`, which a tab reads once, when it has no choice of its
 *   own yet.
 *
 * Both hold the ID of a workspace, so a choice says whose it is: one that
 * somebody else left behind names none of the workspaces of whoever is
 * signed in now, and counts as no choice.
 */
const storageKey = "pigy-workspace";

export const environmentLabels: Record<Environment, string> = {
  live: "Live",
  sandbox: "Sandbox",
};

/**
 * The workspace that this tab shows, of `workspaces`, those of whoever is
 * signed in. Somebody who has never chosen starts in the sandbox.
 */
export function chosenWorkspace(workspaces: Workspace[]): Workspace {
  const ofTab = sessionStorage.getItem(storageKey);
  const ofDevice = localStorage.getItem(storageKey);
  const workspace = workspaceToShow(workspaces, [ofTab, ofDevice]);
  if (!workspace) throw new Error("There is no workspace to show");
  // From here on the tab goes by its own choice, also if it was the
  // device's until now: what is chosen in another tab does not reach it.
  if (ofTab !== workspace.id) sessionStorage.setItem(storageKey, workspace.id);
  // Nothing of somebody who used the device before stays on it.
  if (ofDevice !== null && !workspaces.some(({ id }) => id === ofDevice)) {
    localStorage.removeItem(storageKey);
  }
  return workspace;
}

/**
 * Makes this tab show `workspace` the next time it asks which one to show.
 * For what is not a choice of the person, such as an address that names a
 * workspace: the device goes on remembering what they chose.
 */
export function showWorkspace(workspace: Workspace): void {
  sessionStorage.setItem(storageKey, workspace.id);
}

/** Forgets the choice, in this tab and on the device: after a sign-out. */
export function forgetWorkspaceChoice(): void {
  sessionStorage.removeItem(storageKey);
  localStorage.removeItem(storageKey);
}

const leaving = new Set<() => void>();

/**
 * Calls `listener` when this tab is about to show another workspace. For
 * what is on screen and belongs to no screen, such as a notice that offers
 * to undo something: it is about the workspace that goes, and must not
 * stay under the name of the other one. Returns how to stop.
 */
export function onLeaveWorkspace(listener: () => void): () => void {
  leaving.add(listener);
  return () => leaving.delete(listener);
}

/**
 * Returns the function behind the switch between live and sandbox: it
 * makes this tab show the workspace of `environment`, on the screen that
 * it is on, and has the device remember that.
 *
 * The screens are given the other workspace and its data in one step, so
 * nothing of one is ever shown under the name of the other. What the
 * address says beyond the screen goes, such as the draft that is open: it
 * names something of the workspace that is left.
 */
export function useSwitchWorkspace(): (environment: Environment) => void {
  const router = useRouter();
  const { me, workspace, workspaces } = useRouteContext({ from: "/_app" });

  return useCallback(
    async (environment: Environment) => {
      const next = workspaces.find(
        (candidate) => candidate.environment === environment,
      );
      if (!next || next.id === workspace.id) return;
      try {
        // Before anything changes: a copy that cannot be opened leaves
        // the tab where it is. Opened here, it is there at once for the
        // screens.
        await workspaceSync(me.user.id, next.id);
      } catch (error) {
        console.error(error);
        toast.error(
          `${environmentLabels[environment]} could not be opened on this device`,
          { description: "It may be out of space. Try again." },
        );
        return;
      }
      showWorkspace(next);
      localStorage.setItem(storageKey, next.id);
      for (const listener of [...leaving]) listener();
      await router.navigate({ to: ".", search: {}, replace: true });
    },
    [router, me, workspace, workspaces],
  );
}
