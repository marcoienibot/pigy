import { useRouteContext } from "@tanstack/react-router";
import { ChevronsUpDown, LogOut } from "lucide-react";
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { signOut } from "@/lib/api";
import { forgetSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { countUnsynced } from "@/sync/indexed-db";

/** Up to two letters to show in place of a picture. */
function initials(name: string): string {
  const [first = "", second = ""] = name.trim().split(/\s+/);
  return (first.charAt(0) + second.charAt(0)).toUpperCase();
}

function Avatar({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-[0.625rem] font-medium text-primary-foreground"
    >
      {initials(name)}
    </span>
  );
}

/**
 * Who is signed in, and the way to sign out. In the sidebar it shows the
 * name. In the header of a phone it is only the avatar.
 */
export function UserMenu({ placement }: { placement: "sidebar" | "header" }) {
  const { user } = useRouteContext({ from: "/_app" }).me;
  const inSidebar = placement === "sidebar";
  // Whether the last attempt to sign out failed, until the person has
  // answered that.
  const [signOutFailed, setSignOutFailed] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  // How many changes signing out would lose, while the person is asked
  // whether to go ahead. Null when there is nothing to ask.
  const [unsynced, setUnsynced] = useState<number | null>(null);

  const signOutAndLeave = async () => {
    setSigningOut(true);
    try {
      await signOut();
    } catch {
      // The session may still be good, so the app stays and says so. Going
      // to the sign-in page would look like having signed out whenever that
      // page cannot reach the server either, and on a shared device somebody
      // would walk away from a session that the next person can use.
      setSignOutFailed(true);
      setSigningOut(false);
      return;
    }
    // Signing out leaves nothing of the person on the device. If deleting
    // fails, the sign-in page finds what is left and deals with it.
    await forgetSession().catch((error: unknown) => console.error(error));
    // A full page load, so that nothing of the session stays in memory.
    window.location.assign("/sign-in");
  };

  // Signing out deletes the local copy, and with it what the server has
  // not got yet: only the person can say whether that may go.
  const askOrSignOut = async () => {
    const count = await countUnsynced(user.id).catch(() => 0);
    if (count > 0) setUnsynced(count);
    else await signOutAndLeave();
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Account"
          className={cn(
            "flex items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring",
            inSidebar
              ? "h-9 w-full px-2 text-left hover:bg-sidebar-accent aria-expanded:bg-sidebar-accent"
              : "size-8 justify-center",
          )}
        >
          <Avatar name={user.name} />
          {inSidebar && (
            <>
              <span className="min-w-0 flex-1 truncate">{user.name}</span>
              <ChevronsUpDown
                aria-hidden="true"
                className="size-3.5 shrink-0 text-muted-foreground"
              />
            </>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side={inSidebar ? "top" : "bottom"}
          align={inSidebar ? "start" : "end"}
          className="w-56"
        >
          <DropdownMenuGroup>
            <DropdownMenuLabel className="font-normal">
              <span className="block truncate font-medium text-foreground">
                {user.name}
              </span>
              <span className="block truncate">{user.email}</span>
            </DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={askOrSignOut}>
            <LogOut aria-hidden="true" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog
        open={unsynced !== null}
        onOpenChange={(open) => {
          if (!open) setUnsynced(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {unsynced === 1
                ? "1 change has not been synced"
                : `${unsynced} changes have not been synced`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {unsynced === 1 ? "It exists" : "They exist"} only on this device.
              Signing out deletes {unsynced === 1 ? "it" : "them"}. To keep{" "}
              {unsynced === 1 ? "it" : "them"}, stay signed in until pigy is
              back online.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay signed in</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={signingOut}
              onClick={async () => {
                setUnsynced(null);
                await signOutAndLeave();
              }}
            >
              Sign out and delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={signOutFailed} onOpenChange={setSignOutFailed}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Signing out could not be confirmed
            </AlertDialogTitle>
            <AlertDialogDescription>
              You may still be signed in on this device. Check your connection
              and try again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
            <AlertDialogAction disabled={signingOut} onClick={signOutAndLeave}>
              Try again
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
