import { type Environment, environments } from "@pigy/core";
import { useRouteContext } from "@tanstack/react-router";
import { ChevronsUpDown, FlaskConical, Radio } from "lucide-react";
import { useId } from "react";
import { describeSync, syncTones } from "@/components/sync-indicator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  environmentLabels,
  useOtherWorkspaceSync,
  useSwitchWorkspace,
} from "@/lib/workspace";

/** What tells the two apart wherever one of them is named. */
export const environmentIcons: Record<Environment, typeof Radio> = {
  live: Radio,
  sandbox: FlaskConical,
};

const descriptions: Record<Environment, string> = {
  live: "Your real accounts. What you publish is public.",
  sandbox: "Simulated networks, to try things. Nothing is posted for real.",
};

/** The colour of the sandbox, which the live side has nowhere. */
const sandboxTone = "text-amber-700 dark:text-amber-400";

/**
 * What the workspace that is not on screen has to say for itself: that it
 * holds changes which this window could not save, or which wait to be
 * sent. The sync indicator is about the workspace on screen, and "Synced"
 * there must not be taken for the whole window. In the words that the
 * indicator would use if that workspace were the one on screen.
 *
 * Nothing when it holds no such change, and nothing while its changes are
 * on their way, which is over in a moment.
 */
function useWaitingElsewhere() {
  const other = useOtherWorkspaceSync();
  if (!other || other.sync.pending === 0) return undefined;
  const { label, tone } = describeSync(other.sync);
  if (tone === "busy") return undefined;
  return { environment: other.workspace.environment, label, tone };
}

/**
 * The switch between live and sandbox: it says which of the two this tab
 * shows, and opens the choice. In the sidebar it is a row. In the header
 * of a phone it is a pill.
 *
 * It also says when the other one holds changes that are not saved or not
 * sent: with a dot, in words under the row of the sidebar, and in words at
 * that workspace in the choice, which is where a phone has room for them.
 */
export function WorkspaceSwitch({
  placement,
}: {
  placement: "sidebar" | "header";
}) {
  const { workspace } = useRouteContext({ from: "/_app" });
  const switchWorkspace = useSwitchWorkspace();
  const waiting = useWaitingElsewhere();
  const noteId = useId();
  const { environment } = workspace;
  const inSidebar = placement === "sidebar";
  const Icon = environmentIcons[environment];

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Workspace: ${environmentLabels[environment]}`}
          aria-describedby={waiting ? noteId : undefined}
          className={cn(
            "flex items-center outline-none focus-visible:ring-2 focus-visible:ring-ring",
            environment === "sandbox" && sandboxTone,
            inSidebar
              ? "h-7 w-full gap-2 rounded-md px-2 text-left hover:bg-sidebar-accent aria-expanded:bg-sidebar-accent"
              : "h-6 gap-1 rounded-full border px-2 text-xs",
          )}
        >
          <Icon
            aria-hidden="true"
            className={cn("shrink-0", inSidebar ? "size-4" : "size-3")}
          />
          <span className="min-w-0 flex-1 truncate font-medium">
            {environmentLabels[environment]}
          </span>
          {waiting && (
            <span
              aria-hidden="true"
              className={cn(
                "size-2 shrink-0 rounded-full",
                syncTones[waiting.tone],
              )}
            />
          )}
          {inSidebar && (
            <ChevronsUpDown
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground"
            />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align={inSidebar ? "start" : "end"}
          className="w-64"
        >
          <DropdownMenuGroup>
            <DropdownMenuLabel>Workspace</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={environment}
              onValueChange={(value) => switchWorkspace(value)}
            >
              {environments.map((option) => {
                const OptionIcon = environmentIcons[option];
                return (
                  <DropdownMenuRadioItem
                    key={option}
                    value={option}
                    // A choice, not a setting to try out: the menu closes.
                    closeOnClick
                    className="items-start gap-2 py-1.5"
                  >
                    <OptionIcon aria-hidden="true" className="mt-0.5" />
                    <span>
                      <span className="block font-medium">
                        {environmentLabels[option]}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {descriptions[option]}
                      </span>
                      {waiting?.environment === option && (
                        <span className="mt-0.5 flex items-center gap-1.5 text-xs">
                          <span
                            aria-hidden="true"
                            className={cn(
                              "size-2 shrink-0 rounded-full",
                              syncTones[waiting.tone],
                            )}
                          />
                          {waiting.label}
                        </span>
                      )}
                    </span>
                  </DropdownMenuRadioItem>
                );
              })}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {waiting && (
        // What the dot stands for, which describes the switch to those
        // who cannot see it.
        <p
          id={noteId}
          className={
            inSidebar
              ? "truncate px-2 pt-1 text-xs text-muted-foreground"
              : "sr-only"
          }
        >
          {environmentLabels[waiting.environment]}: {waiting.label}
        </p>
      )}
    </>
  );
}

/**
 * Says that this is the sandbox, across the top of every screen, so that
 * nobody takes it for the real thing. The live side has no such line.
 */
export function SandboxBanner() {
  const { workspace } = useRouteContext({ from: "/_app" });
  if (workspace.environment !== "sandbox") return null;

  return (
    <p
      role="note"
      className="flex h-7 shrink-0 items-center justify-center gap-1.5 bg-amber-100 px-4 text-xs text-amber-950 dark:bg-amber-950 dark:text-amber-100"
    >
      <FlaskConical aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="font-semibold">Sandbox</span>
      <span className="truncate">
        Simulated networks. Nothing is posted for real.
      </span>
    </p>
  );
}
