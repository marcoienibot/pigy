import { Link, linkOptions } from "@tanstack/react-router";
import { CalendarClock, PenLine, Send, Settings, Share2 } from "lucide-react";
import type { ReactNode } from "react";
import { UserMenu } from "@/components/user-menu";
import { cn } from "@/lib/utils";

const navItems = linkOptions([
  { to: "/", label: "Drafts", icon: PenLine },
  { to: "/queue", label: "Queue", icon: CalendarClock },
  { to: "/sent", label: "Sent", icon: Send },
  { to: "/channels", label: "Channels", icon: Share2 },
  { to: "/settings", label: "Settings", icon: Settings },
]);

/** Sidebar on desktop, bottom tab bar on phones. */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-dvh flex-col md:flex-row">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex">
        <div className="flex h-11 shrink-0 items-center gap-2 px-4">
          <img src="/icon.svg" alt="" className="size-5 rounded-sm" />
          <span className="font-semibold tracking-tight">pigy</span>
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
            </Link>
          ))}
        </nav>
        <div className="p-2">
          <UserMenu placement="sidebar" />
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>

      <nav
        aria-label="Main"
        className="flex shrink-0 border-t bg-background pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {navItems.map(({ label, icon: Icon, ...link }) => (
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
  );
}
