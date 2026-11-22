import { Link, linkOptions, useRouteContext } from "@tanstack/react-router";
import {
  Bell,
  CalendarClock,
  Globe,
  PenLine,
  Send,
  Settings,
  Share2,
} from "lucide-react";
import { type ReactNode, useEffect } from "react";
import {
  CommandPalette,
  useOpenCommandPalette,
} from "@/components/command-palette";
import { unreadLabel } from "@/components/inbox-bell";
import { Rejections } from "@/components/rejections";
import { SyncIndicator } from "@/components/sync-indicator";
import { Kbd } from "@/components/ui/kbd";
import { Toaster } from "@/components/ui/sonner";
import { UserMenu } from "@/components/user-menu";
import { SandboxBanner, WorkspaceSwitch } from "@/components/workspace-switch";
import { selectUnread } from "@/lib/inbox";
import { modKey } from "@/lib/keyboard";
import { dismissWorkspaceNotices } from "@/lib/notices";
import { cn } from "@/lib/utils";
import { hasScreen } from "@/lib/workspace";
import { useSynced } from "@/sync/react";

/**
 * The screens of the navigation. A workspace shows those that it has. The
 * bar of a phone has room for six and has six in the sandbox, so the inbox
 * is in the sidebar alone: on a phone it is the bell in the header of
 * every screen, `InboxBell`.
 */
const allNavItems = linkOptions([
  { to: "/inbox", label: "Inbox", icon: Bell },
  { to: "/", label: "Drafts", icon: PenLine },
  { to: "/queue", label: "Queue", icon: CalendarClock },
  { to: "/sent", label: "Sent", icon: Send },
  { to: "/channels", label: "Channels", icon: Share2 },
  { to: "/simulator", label: "Simulator", icon: Globe },
  { to: "/settings", label: "Settings", icon: Settings },
]);

/** The screens that the bar of a phone leaves to the header. */
const sidebarOnly: ReadonlySet<string> = new Set(["/inbox"]);

/** Opens the command palette, and says which keys do the same. */
function CommandsButton() {
  const open = useOpenCommandPalette();
  return (
    <button
      type="button"
      onClick={open}
      className="ml-auto flex h-6 items-center gap-1 rounded-md px-1 text-xs text-muted-foreground outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"
    >
      <span className="sr-only">Commands</span>
      <Kbd>{modKey}</Kbd>
      <Kbd>K</Kbd>
    </button>
  );
}

/**
 * Sidebar on desktop, bottom tab bar on phones, and what every screen has
 * around it: the banner of the sandbox, the command palette and the
 * notices.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { workspace } = useRouteContext({ from: "/_app" });
  return (
    <CommandPalette>
      <Shell>{children}</Shell>
      <Notices key={workspace.id} />
    </CommandPalette>
  );
}

/**
 * The notices of the workspace on screen: where they are shown, and those
 * of its refused changes.
 *
 * A notice is about the workspace that it was made in, and so is what it
 * offers to do: the undo of a deleted draft would bring the draft back
 * into that workspace. So this is made anew for every workspace, like the
 * screens, with the workspace as its key. The notices of the one before
 * leave the page in the step in which the shell changes its name: none of
 * them is on screen under the name of the other, not for a moment, and
 * none can be pressed there. Taking them off through the notice library
 * would not do that. It removes a notice over several frames.
 *
 * A few notices are not about a workspace but for the person, and say
 * which workspace they are about: `lib/notices.ts`. Those are on screen
 * again in the next list, until the person closes them.
 */
function Notices() {
  // The library keeps its notices outside of React, and hands the ones
  // that nobody has dismissed to every list that is new. The next list is
  // that of another workspace, so the notices of this one end with it.
  // What is left is handed on: the notices of the person.
  useEffect(() => dismissWorkspaceNotices, []);

  return (
    <>
      {/* On a phone, above the bottom bar, which is taller where the
          phone keeps the bottom of the screen for itself. */}
      <Toaster
        position="bottom-right"
        mobileOffset={{ bottom: "calc(72px + env(safe-area-inset-bottom))" }}
      />
      <Rejections />
    </>
  );
}

function Shell({ children }: { children: ReactNode }) {
  // From the same place as the screens, so that the navigation changes
  // with them and with the name of the workspace.
  const { workspace } = useRouteContext({ from: "/_app" });
  const navItems = allNavItems.filter(({ to }) =>
    hasScreen(workspace.environment, to),
  );
  const barItems = navItems.filter(({ to }) => !sidebarOnly.has(to));
  const unread = useSynced(selectUnread);
  return (
    // The bottom of a phone's screen is the tab bar's, below.
    <div className="flex h-dvh flex-col px-safe pt-safe md:pb-safe">
      <SandboxBanner />
      {/* Positioned, for what covers the whole app on a phone, such as the
          editor of a draft: it covers this and leaves the banner in sight. */}
      <div className="relative flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="hidden w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex">
          <div className="flex h-11 shrink-0 items-center gap-2 px-4">
            <img src="/icon.svg" alt="" className="size-5 rounded-sm" />
            <span className="font-semibold tracking-tight">pigy</span>
            <CommandsButton />
          </div>
          <div className="px-2 pb-2">
            <WorkspaceSwitch placement="sidebar" />
          </div>
          <nav aria-label="Main" className="flex flex-1 flex-col gap-0.5 px-2">
            {navItems.map(({ label, icon: Icon, ...link }) => (
              <Link
                key={link.to}
                {...link}
                className={cn(
                  "flex h-7 items-center gap-2 rounded-md px-2 text-sidebar-foreground/70 outline-none",
                  "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                  "focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                  "aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium aria-[current=page]:text-sidebar-accent-foreground",
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden="true" />
                {label}
                {link.to === "/inbox" && unread > 0 && (
                  <span className="ml-auto rounded-full bg-destructive px-1.5 text-[11px] leading-4 font-medium text-white">
                    <span aria-hidden="true">{unreadLabel(unread)}</span>
                    <span className="sr-only">{unread} unread</span>
                  </span>
                )}
              </Link>
            ))}
          </nav>
          <div className="flex flex-col gap-0.5 p-2">
            <SyncIndicator placement="sidebar" />
            <UserMenu placement="sidebar" />
          </div>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>

        <nav
          aria-label="Main"
          className="flex shrink-0 border-t bg-background pb-safe md:hidden"
        >
          {barItems.map(({ label, icon: Icon, ...link }) => (
            <Link
              key={link.to}
              {...link}
              className={cn(
                "flex h-14 min-w-0 flex-1 flex-col items-center justify-center gap-1 text-xs text-muted-foreground outline-none",
                "focus-visible:bg-accent",
                "aria-[current=page]:font-medium aria-[current=page]:text-foreground",
              )}
            >
              <Icon className="size-5 shrink-0" aria-hidden="true" />
              <span className="truncate">{label}</span>
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}
