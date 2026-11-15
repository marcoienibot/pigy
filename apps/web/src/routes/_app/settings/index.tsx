import { createFileRoute } from "@tanstack/react-router";
import { type Theme, themes, useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { isInstalled, isIos, useInstall } from "@/lib/install";
import { useReloadToUpdate, useUpdateOffer } from "@/lib/reload-to-update";

export const Route = createFileRoute("/_app/settings/")({
  component: General,
});

const themeLabels: Record<Theme, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

/**
 * pigy as an app on this device: installing it, and loading a new version
 * of it. Nothing where there is nothing to do.
 */
function App() {
  const install = useInstall();
  const update = useUpdateOffer();
  const { reloading, reload } = useReloadToUpdate();
  // Safari offers nothing that a button could start, so on an iPhone or
  // iPad the person is told where the browser has it.
  const explain = isIos && !isInstalled();
  if (!install && !explain && !update) return null;

  return (
    <section className="mt-8">
      <h2 className="font-medium">App</h2>
      <div className="mt-3 divide-y rounded-lg border">
        {install && (
          <div className="flex items-center justify-between gap-4 px-3 py-2">
            <p>
              Install pigy
              <span className="block text-muted-foreground">
                It opens in a window of its own, also without a connection.
              </span>
            </p>
            <Button variant="outline" size="sm" onClick={install}>
              Install
            </Button>
          </div>
        )}
        {explain && (
          <p className="px-3 py-2">
            Install pigy
            <span className="block text-muted-foreground">
              Open the Share menu of the browser and choose “Add to Home
              Screen”. pigy then opens like an app, also without a connection.
            </span>
          </p>
        )}
        {update && (
          <div className="flex items-center justify-between gap-4 px-3 py-2">
            <p>
              A new version of pigy is ready
              <span className="block text-muted-foreground">
                It takes over the next time pigy is opened, or now.
              </span>
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={reloading}
              onClick={reload}
            >
              Reload to update
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

function General() {
  return (
    <>
      <Appearance />
      <App />
    </>
  );
}

function Appearance() {
  const { theme, setTheme } = useTheme();

  return (
    <section>
      <h2 className="font-medium">Appearance</h2>
      <div className="mt-3 flex items-center justify-between gap-4 rounded-lg border px-3 py-2">
        <span id="theme-label">Theme</span>
        <ToggleGroup
          aria-labelledby="theme-label"
          variant="outline"
          size="sm"
          spacing={0}
          value={[theme]}
          onValueChange={([value]) => {
            // Pressing the active option clears the selection. Keep the
            // current theme in that case.
            const next = themes.find((option) => option === value);
            if (next) setTheme(next);
          }}
        >
          {themes.map((value) => (
            <ToggleGroupItem key={value} value={value}>
              {themeLabels[value]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
    </section>
  );
}
