import { useState } from "react";
import { getInitialTheme, applyTheme, toggleTheme, type Theme } from "./theme.js";

function SunIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
    </svg>
  );
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => {
    const initial = getInitialTheme();
    applyTheme(initial);
    return initial;
  });

  function handleClick() {
    setTheme(toggleTheme());
  }

  const switchToLabel = theme === "dark" ? "light mode" : "dark mode";

  return (
    <button type="button" className="theme-toggle" onClick={handleClick} aria-label={`Switch to ${switchToLabel}`}>
      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}
