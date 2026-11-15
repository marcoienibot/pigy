import { useState } from "react";
import { toast } from "sonner";
import { reloadToUpdate } from "@/lib/service-worker";

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
