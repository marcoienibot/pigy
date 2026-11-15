import { type Environment, environments } from "@pigy/core";
import { useRouteContext } from "@tanstack/react-router";
import { ChevronsUpDown, FlaskConical, Radio } from "lucide-react";
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
import { environmentLabels, useSwitchWorkspace } from "@/lib/workspace";

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
 * The switch between live and sandbox: it says which of the two this tab
 * shows, and opens the choice. In the sidebar it is a row. In the header
 * of a phone it is a pill.
 */
export function WorkspaceSwitch({
  placement,
}: {
  placement: "sidebar" | "header";
}) {
  const { workspace } = useRouteContext({ from: "/_app" });
  const switchWorkspace = useSwitchWorkspace();
  const { environment } = workspace;
  const inSidebar = placement === "sidebar";
  const Icon = environmentIcons[environment];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Workspace: ${environmentLabels[environment]}`}
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
        {inSidebar && (
          <ChevronsUpDown
            aria-hidden="true"
            className="size-3.5 shrink-0 text-muted-foreground"
          />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={inSidebar ? "start" : "end"} className="w-64">
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
                  </span>
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
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
