import { createFileRoute } from "@tanstack/react-router";
import { type Theme, themes, useTheme } from "@/components/theme-provider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export const Route = createFileRoute("/_app/settings/")({
  component: General,
});

const themeLabels: Record<Theme, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

function General() {
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
