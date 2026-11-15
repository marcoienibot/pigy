import { environments } from "@pigy/core";
import {
  useNavigate,
  useRouteContext,
  useRouter,
} from "@tanstack/react-router";
import {
  CalendarClock,
  Monitor,
  Moon,
  PenLine,
  Plus,
  Send,
  Settings,
  Share2,
  Sun,
  UserPlus,
} from "lucide-react";
import { createContext, type ReactNode, use, useMemo, useState } from "react";
import { type Theme, useTheme } from "@/components/theme-provider";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { environmentIcons } from "@/components/workspace-switch";
import { overChannels } from "@/lib/channels";
import { useNewDraft } from "@/lib/drafts";
import {
  dialogIsOpen,
  modKey,
  useKeyDown,
  useShortcuts,
  withMod,
} from "@/lib/keyboard";
import { environmentLabels, useSwitchWorkspace } from "@/lib/workspace";

const screens = [
  { to: "/", label: "Drafts", icon: PenLine },
  { to: "/queue", label: "Queue", icon: CalendarClock },
  { to: "/sent", label: "Sent", icon: Send },
  { to: "/channels", label: "Channels", icon: Share2 },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

const themes: { theme: Theme; label: string; icon: typeof Sun }[] = [
  { theme: "light", label: "Light", icon: Sun },
  { theme: "dark", label: "Dark", icon: Moon },
  { theme: "system", label: "System", icon: Monitor },
];

const PaletteContext = createContext<(() => void) | null>(null);

/** Returns the function that opens the command palette. */
export function useOpenCommandPalette(): () => void {
  const open = use(PaletteContext);
  if (!open) throw new Error("The command palette is not mounted");
  return open;
}

/**
 * The command palette: what the app can do on every screen, to search by
 * name. It opens with ⌘K or Ctrl+K, also while typing, and from whatever
 * calls `useOpenCommandPalette()` below it. The shortcuts that work on
 * every screen are here too.
 *
 * It does not open over another dialog. What that dialog asks comes
 * first, and a command would change the app behind it: going to another
 * screen or to the other workspace takes away the screen that a request
 * of the dialog is to answer on. The shortcuts keep to the same rule, the
 * one below and those of the screens: `useShortcuts` hands out no key
 * press while a dialog is open.
 */
export function CommandPalette({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const router = useRouter();
  const newDraft = useNewDraft();
  const { theme: current, setTheme } = useTheme();
  const { workspace } = useRouteContext({ from: "/_app" });
  const switchWorkspace = useSwitchWorkspace();

  useKeyDown((event) => {
    if (withMod(event) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (open) setOpen(false);
      else if (!dialogIsOpen()) setOpen(true);
    }
  });
  // The one command with a key of its own on every screen.
  useShortcuts((event) => {
    if (event.key.toLowerCase() === "c") {
      event.preventDefault();
      newDraft();
    }
  });

  /** Closes the palette, then does what was chosen. */
  const run = (command: () => void) => () => {
    setOpen(false);
    command();
  };
  const show = useMemo(() => () => setOpen(true), []);

  return (
    <PaletteContext value={show}>
      {children}
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Commands"
        description="Search for something to do or a screen to go to."
      >
        <Command>
          <CommandInput placeholder="Type a command or search…" />
          <CommandList>
            <CommandEmpty>Nothing found.</CommandEmpty>
            <CommandGroup heading="Drafts">
              <CommandItem onSelect={run(() => newDraft())}>
                <Plus aria-hidden="true" />
                New draft
                <CommandShortcut>
                  <Kbd>C</Kbd>
                </CommandShortcut>
              </CommandItem>
            </CommandGroup>
            <CommandGroup heading="Channels">
              <CommandItem
                onSelect={run(
                  () =>
                    void navigate({
                      to: "/channels",
                      search: { add: true },
                      // On the Channels screen the dialog opens over the
                      // screen, as its own button opens it, and closing
                      // it leads back to the screen: the entry says so.
                      // The palette does not open over a dialog, so the
                      // screen is there without one.
                      ...(router.history.location.pathname === "/channels" && {
                        state: overChannels,
                      }),
                    }),
                )}
              >
                <UserPlus aria-hidden="true" />
                Connect an account
              </CommandItem>
            </CommandGroup>
            <CommandGroup heading="Workspace">
              {environments
                .filter((environment) => environment !== workspace.environment)
                .map((environment) => {
                  const Icon = environmentIcons[environment];
                  return (
                    <CommandItem
                      key={environment}
                      keywords={["workspace"]}
                      onSelect={run(() => switchWorkspace(environment))}
                    >
                      <Icon aria-hidden="true" />
                      Switch to {environmentLabels[environment].toLowerCase()}
                    </CommandItem>
                  );
                })}
            </CommandGroup>
            <CommandGroup heading="Go to">
              {screens.map(({ to, label, icon: Icon }) => (
                <CommandItem
                  key={to}
                  value={`Go to ${label}`}
                  onSelect={run(() => void navigate({ to }))}
                >
                  <Icon aria-hidden="true" />
                  {label}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandGroup heading="Theme">
              {themes.map(({ theme, label, icon: Icon }) => (
                <CommandItem
                  key={theme}
                  value={`Theme ${label}`}
                  data-checked={theme === current}
                  onSelect={run(() => setTheme(theme))}
                >
                  <Icon aria-hidden="true" />
                  {label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          <div className="flex items-center justify-end gap-3 border-t px-3 py-2 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> to move
            </span>
            <span className="flex items-center gap-1">
              <Kbd>↵</Kbd> to run
            </span>
            <span className="flex items-center gap-1">
              <Kbd>{modKey}</Kbd>
              <Kbd>K</Kbd> to close
            </span>
          </div>
        </Command>
      </CommandDialog>
    </PaletteContext>
  );
}
