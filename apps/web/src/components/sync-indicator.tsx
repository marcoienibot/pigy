import type { SyncState } from "@pigy/core";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useSyncState } from "@/sync/react";

function changes(count: number): string {
  return count === 1 ? "1 change" : `${count} changes`;
}

type Description = {
  /** A few words, always on screen where there is room. */
  label: string;
  /** What it means for the person, shown on hover or tap. */
  detail: string;
  /** The colour of the dot. */
  tone: "good" | "busy" | "waiting" | "stuck";
  /** Whether loading the app again is what helps. */
  reload?: true;
};

function describe({
  connection,
  pending,
  unsaved,
  outdated,
}: SyncState): Description {
  // Before anything about the connection: these changes are not on their
  // way anywhere, and the advice to reload would lose them.
  if (unsaved > 0) {
    return {
      label: `Not saved · ${changes(unsaved)}`,
      detail: `pigy could not save ${changes(unsaved)} on this device, which may be out of space. ${
        unsaved === 1 ? "It exists" : "They exist"
      } only in this window: keep it open while pigy tries again.`,
      tone: "stuck",
    };
  }
  const kept =
    pending > 0
      ? `${changes(pending)} ${pending === 1 ? "is" : "are"} saved on this device`
      : "";
  if (outdated) {
    return {
      label: "Reload to update",
      detail: `This window runs an older version of pigy and has stopped syncing. ${
        kept ? `${kept} and will sync after a reload.` : "Reload it to go on."
      }`,
      tone: "stuck",
      reload: true,
    };
  }
  switch (connection) {
    case "online":
      return pending > 0
        ? {
            label: `Syncing ${changes(pending)}`,
            detail: `${kept} and on ${pending === 1 ? "its" : "their"} way to your account.`,
            tone: "busy",
          }
        : {
            label: "Synced",
            detail: "Everything is saved to your account.",
            tone: "good",
          };
    case "connecting":
      return {
        label: pending > 0 ? `Syncing ${changes(pending)}` : "Connecting",
        detail: kept
          ? `Connecting to pigy. ${kept}.`
          : "Connecting to pigy. You can start working.",
        tone: "busy",
      };
    case "replaced":
      return {
        label: "Sync paused",
        detail:
          "Another window has taken over syncing and this one has not heard from it since. Reload this window.",
        tone: "stuck",
        reload: true,
      };
    default:
      // Offline, or a session that has ended, which the app is about to
      // leave for the sign-in page.
      return {
        label: pending > 0 ? `Offline · ${changes(pending)}` : "Offline",
        detail: kept
          ? `${kept} and will sync when the connection is back.`
          : "You can keep working. What you change is saved on this device and syncs when the connection is back.",
        tone: "waiting",
      };
  }
}

const tones: Record<Description["tone"], string> = {
  good: "bg-emerald-500",
  busy: "bg-sky-500 motion-safe:animate-pulse",
  waiting: "bg-amber-500",
  stuck: "bg-destructive",
};

/**
 * How sync is getting on, in a dot and a few words, with the rest on hover
 * or tap. In the sidebar it shows the words. In the header of a phone it is
 * only the dot.
 */
export function SyncIndicator({
  placement,
}: {
  placement: "sidebar" | "header";
}) {
  const { label, detail, tone, reload } = describe(useSyncState());
  const inSidebar = placement === "sidebar";

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        aria-label={`Sync: ${label}`}
        className={cn(
          "flex items-center gap-2 rounded-md text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring",
          inSidebar
            ? "h-7 w-full px-2 text-left text-xs hover:bg-sidebar-accent aria-expanded:bg-sidebar-accent"
            : "size-8 justify-center",
        )}
      >
        <span
          aria-hidden="true"
          className={cn("size-2 shrink-0 rounded-full", tones[tone])}
        />
        {inSidebar && <span className="truncate">{label}</span>}
      </PopoverTrigger>
      <PopoverContent
        side={inSidebar ? "top" : "bottom"}
        align={inSidebar ? "start" : "end"}
        className="w-64"
      >
        <PopoverHeader>
          <PopoverTitle>{label}</PopoverTitle>
          <PopoverDescription>{detail}</PopoverDescription>
        </PopoverHeader>
        {reload && (
          <Button size="sm" onClick={() => window.location.reload()}>
            Reload
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
