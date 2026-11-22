import { Link } from "@tanstack/react-router";
import { Bell } from "lucide-react";
import { selectUnread } from "@/lib/inbox";
import { cn } from "@/lib/utils";
import { useSynced } from "@/sync/react";

/** How many are unread, as the bell and the navigation say it. */
export function unreadLabel(unread: number): string {
  return unread > 99 ? "99+" : String(unread);
}

/**
 * The way to the inbox from the header of a phone, with how many
 * notifications are unread. The bar at the bottom of a phone has room for
 * six screens and has six in the sandbox, so the inbox is not among them:
 * it is here, on every screen, where a count is seen without looking for
 * it. On a desktop the inbox is in the navigation of the sidebar.
 */
export function InboxBell() {
  const unread = useSynced(selectUnread);
  return (
    <Link
      to="/inbox"
      aria-label={unread > 0 ? `Inbox, ${unread} unread` : "Inbox"}
      className={cn(
        "relative flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none",
        "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
        "aria-[current=page]:text-foreground",
      )}
    >
      <Bell className="size-4" aria-hidden="true" />
      {unread > 0 && (
        <span
          aria-hidden="true"
          className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] leading-none font-medium text-white"
        >
          {unreadLabel(unread)}
        </span>
      )}
    </Link>
  );
}
