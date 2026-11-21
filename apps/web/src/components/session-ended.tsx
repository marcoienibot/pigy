import { useState, useSyncExternalStore } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  discardUnsaved,
  onSessionEndHeld,
  sessionEndHeld,
} from "@/lib/session";
import { useUnsavedInTab } from "@/lib/workspace";

/**
 * Says that the session has ended, in a window that stays open after that
 * because it holds changes which it has not stored: see `savedOrDiscarded`
 * in `lib/session.ts`. It is over the app and cannot be closed, so nothing
 * of the workspace behind it can be used as if the session were good. The
 * window leaves for the sign-in page by itself once the changes are
 * stored, and at once if the person says that it may go without them.
 *
 * It belongs to no screen and no workspace: the route above all others
 * shows it.
 */
export function SessionEnded() {
  const held = useSyncExternalStore(onSessionEndHeld, sessionEndHeld);
  const unsaved = useUnsavedInTab();
  const [leaving, setLeaving] = useState(false);
  if (!held) return null;

  return (
    <AlertDialog open>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>You have been signed out</AlertDialogTitle>
          <AlertDialogDescription>
            {
              // None is counted while a write is under way that has not
              // failed: it is slow, and may yet end either way.
              unsaved === 0
                ? "pigy has not finished saving your last changes on this device."
                : `pigy could not save ${
                    unsaved === 1 ? "1 change" : `${unsaved} changes`
                  } on this device, which may be out of space.`
            }{" "}
            They exist only in this window. pigy keeps trying, and goes to the
            sign-in page once they are saved: they are synced when you sign in
            again. If you go there now, they are lost.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction
            variant="destructive"
            disabled={leaving}
            onClick={(event) => {
              // The dialog stays until the page has gone.
              event.preventDefault();
              setLeaving(true);
              discardUnsaved();
            }}
          >
            Lose them and sign in
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
