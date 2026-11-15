import { useState } from "react";
import { toast } from "sonner";
import { reloadToUpdate, useUpdateReady } from "@/lib/service-worker";
import { useUnsavedInTab } from "@/lib/workspace";

/**
 * Whether to offer a newer version of the app, as Settings and the command
 * palette do: one is installed and waits, and this tab holds no change that
 * it could not store, in either workspace. The reload would wait for those,
 * and the window must stay open until they are stored, as its sync
 * indicator says, or the switch for the other workspace.
 */
export function useUpdateOffer(): boolean {
  const ready = useUpdateReady();
  const unsaved = useUnsavedInTab();
  return ready && unsaved === 0;
}

/**
 * What a button that says "Reload to update" does, and whether it is at
 * it: the reload first asks the server for the version to load, which can
 * take a moment.
 *
 * The reload does not happen while another window holds changes that it
 * could not store, see `reloadToUpdate`. The person is told why, and the
 * button can be pressed again: nothing says when that window is done.
 */
export function useReloadToUpdate(): {
  reloading: boolean;
  reload: () => void;
} {
  const [reloading, setReloading] = useState(false);
  return {
    reloading,
    reload() {
      setReloading(true);
      // Resolves only if the page stays.
      void reloadToUpdate().then(() => {
        setReloading(false);
        toast("pigy cannot update yet", {
          // With an ID, pressing the button again does not stack a second
          // notice on the first.
          id: "update-blocked",
          description:
            "Another pigy window holds changes that it could not save. pigy updates once they are saved or that window is closed.",
          // Two sentences take longer to read than the usual four seconds.
          duration: 10_000,
        });
      });
    },
  };
}
