import { useRouteContext } from "@tanstack/react-router";
import { ChevronsUpDown, LogOut } from "lucide-react";
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
import { cn } from "@/lib/utils";

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

async function signOutAndLeave() {
  try {
    await signOut();
  } finally {
    // A full page load, so that nothing of the session stays in memory. If
    // signing out failed, the sign-in page leads straight back into the app.
    window.location.assign("/sign-in");
  }
}

/**
 * Who is signed in, and the way to sign out. In the sidebar it shows the
 * name. In the header of a phone it is only the avatar.
 */
export function UserMenu({ placement }: { placement: "sidebar" | "header" }) {
  const { user } = useRouteContext({ from: "/_app" }).me;
  const inSidebar = placement === "sidebar";

  return (
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
        <DropdownMenuItem onClick={signOutAndLeave}>
          <LogOut aria-hidden="true" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
