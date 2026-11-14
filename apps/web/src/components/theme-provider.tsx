import { createContext, type ReactNode, use, useEffect, useState } from "react";

export const themes = ["system", "light", "dark"] as const;
export type Theme = (typeof themes)[number];

// Also read by the inline script in index.html, which sets the theme before
// first paint.
const storageKey = "pigy-theme";

type ThemeContextValue = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredTheme(): Theme {
  const stored = localStorage.getItem(storageKey);
  return themes.find((theme) => theme === stored) ?? "system";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState(readStoredTheme);

  useEffect(() => {
    const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark =
        theme === "dark" || (theme === "system" && systemDark.matches);
      document.documentElement.classList.toggle("dark", dark);
    };
    apply();
    systemDark.addEventListener("change", apply);
    return () => systemDark.removeEventListener("change", apply);
  }, [theme]);

  const setTheme = (next: Theme) => {
    localStorage.setItem(storageKey, next);
    setThemeState(next);
  };

  return <ThemeContext value={{ theme, setTheme }}>{children}</ThemeContext>;
}

export function useTheme(): ThemeContextValue {
  const context = use(ThemeContext);
  if (!context) throw new Error("useTheme must be used within ThemeProvider");
  return context;
}
