import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { THEME_STORAGE, ThemeContext, type Theme } from "@/lib/theme";

function readTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_STORAGE);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

/** Light / dark / follow-the-OS, applied as a `.dark` class on <html>. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readTheme);
  const [osDark, setOsDark] = useState(systemDark);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setOsDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const resolvedTheme = theme === "system" ? (osDark ? "dark" : "light") : theme;
  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
  }, [resolvedTheme]);

  const setTheme = useCallback((next: Theme) => {
    try {
      localStorage.setItem(THEME_STORAGE, next);
    } catch {
      // Not persisted; still applied for this visit.
    }
    setThemeState(next);
  }, []);

  const value = useMemo(() => ({ theme, resolvedTheme, setTheme }), [theme, resolvedTheme, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
