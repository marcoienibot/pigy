import { useEffect, useState, useSyncExternalStore } from "react";
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
 * How long the button of `SessionEnded` waits for the page to go before
 * it can be pressed again, in milliseconds.
 */
const leaveMs = 5_000;

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
  const counted = useUnsavedInTab();
  // What the tab counted when the person let the changes go. From then on
  // it counts none, and the dialog, which stays until the page has gone,
  // goes on saying what it said when its button was pressed.
  const [letGo, setLetGo] = useState<number>();
  const unsaved = letGo ?? counted;
  const [leaving, setLeaving] = useState(false);
  // The page is gone a moment after the person has said that it may go.
  // If it is still here, something kept it, and the button has to work
  // again: it is the only way out of a dialog that cannot be closed.
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => setLeaving(false), leaveMs);
    return () => clearTimeout(timer);
  }, [leaving]);
  if (!held) return null;
  const one = unsaved === 1;

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
                    one ? "1 change" : `${unsaved} changes`
                  } on this device, which may be out of space.`
            }{" "}
            {one
              ? "It exists only in this window. pigy keeps trying, and goes to the sign-in page once it is saved: it is synced when you sign in again. If you go there now, it is lost."
              : "They exist only in this window. pigy keeps trying, and goes to the sign-in page once they are saved: they are synced when you sign in again. If you go there now, they are lost."}
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
              setLetGo(unsaved);
              discardUnsaved();
            }}
          >
            Lose {one ? "it" : "them"} and sign in
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
