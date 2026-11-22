import {
  type Environment,
  type SyncState,
  type Workspace,
  workspaceToShow,
} from "@pigy/core";
import { useRouteContext, useRouter } from "@tanstack/react-router";
import { useCallback, useSyncExternalStore } from "react";
import { toast } from "sonner";
import {
  onSyncChange,
  openStore,
  unsavedInTab,
  workspaceSync,
} from "@/sync/workspace-sync";

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
 * Whether the workspace of `environment` has the screen at `path`. The
 * simulator is the sandbox's: the live workspace has no simulated networks
 * to show or to make fail. The one place that says so, for the navigation,
 * the command palette, the screen itself and the switch between the two.
 */
export function hasScreen(environment: Environment, path: string): boolean {
  return (
    environment === "sandbox" ||
    !(path === "/simulator" || path.startsWith("/simulator/"))
  );
}

/**
 * Whether what the address at `path` says is of no workspace, and stays
 * when the tab changes to the other one. That is the screen of something
 * that was shared to pigy: it is nothing of the workspace that is left,
 * and the person may well change workspaces to say where it goes.
 */
export function keepsAddress(path: string): boolean {
  return path === "/share";
}

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

/**
 * Forgets the choice of this tab. Every tab keeps its own where no other
 * tab reaches it, so every tab has to forget it for itself: the one in
 * which somebody signs out, and the others when they hear of it.
 */
export function forgetTabChoice(): void {
  sessionStorage.removeItem(storageKey);
}

/** Forgets the choice, in this tab and on the device: after a sign-out. */
export function forgetWorkspaceChoice(): void {
  forgetTabChoice();
  localStorage.removeItem(storageKey);
}

/**
 * Returns the function behind the switch between live and sandbox: it
 * makes this tab show the workspace of `environment`, on the screen that
 * it is on, and has the device remember that. A screen that the other
 * workspace does not have, as live has no simulator, is left for the
 * drafts: the person asked for the workspace, and not to be told that
 * there is nothing at an address.
 *
 * The screens are given the other workspace and its data in one step, so
 * nothing of one is ever shown under the name of the other. What the
 * address says beyond the screen goes, such as the draft that is open: it
 * names something of the workspace that is left. Unless it is of no
 * workspace: `keepsAddress`.
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
      const { pathname } = router.state.location;
      if (keepsAddress(pathname)) {
        // The same address, loaded anew with the other workspace. Not a
        // navigation: that would write the address again as the router
        // reads it, which is not always as it came.
        await router.invalidate();
        return;
      }
      await router.navigate({
        to: hasScreen(environment, router.state.location.pathname) ? "." : "/",
        search: {},
        replace: true,
      });
    },
    [router, me, workspace, workspaces],
  );
}

/**
 * The workspace that this tab does not show, and how sync is getting on in
 * it. Undefined while the tab does not sync that workspace: it holds
 * nothing of it then.
 *
 * A tab goes on syncing a workspace that it has shown, so it can hold
 * changes of the one that is not on screen: some that are not sent yet, and
 * some that it could not store, which exist in its memory alone. The sync
 * indicator is about the workspace on screen, and this is how the shell
 * finds out what it leaves unsaid.
 */
export function useOtherWorkspaceSync():
  | { workspace: Workspace; sync: SyncState }
  | undefined {
  const { me, workspace, workspaces } = useRouteContext({ from: "/_app" });
  const other = workspaces.find(({ id }) => id !== workspace.id);
  const sync = useSyncExternalStore(onSyncChange, () =>
    other ? openStore(me.user.id, other.id)?.getState() : undefined,
  );
  return other && sync ? { workspace: other, sync } : undefined;
}

/**
 * How many changes this tab holds that it could not store, in both
 * workspaces: `unsavedInTab`. They are in its memory and nowhere else, so
 * a reload would lose them, and whatever reloads waits for them to be
 * stored. What offers a reload does not offer it while there are any.
 */
export function useUnsavedInTab(): number {
  return useSyncExternalStore(onSyncChange, unsavedInTab);
}
