// Mirrors theme.ts's pattern: a localStorage-backed boolean applied as a data attribute on
// <html>, so CSS can scope cowboy-mode-only styling with a single [data-cowboy-mode="true"]
// selector, the same way [data-theme] already scopes dark mode.
export const COWBOY_MODE_STORAGE_KEY = "sfcowboy-cowboy-mode";

// Same-tab consumers (the toggle button, any page reading the current mode) can't rely on the
// browser's own "storage" event -- that only fires in OTHER tabs -- so setCowboyMode dispatches
// this custom event after writing, and useCowboyMode.ts listens for it to re-render immediately.
export const COWBOY_MODE_CHANGE_EVENT = "cowboy-mode-change";

export function getInitialCowboyMode(): boolean {
  return localStorage.getItem(COWBOY_MODE_STORAGE_KEY) === "true";
}

export function applyCowboyMode(enabled: boolean): void {
  document.documentElement.setAttribute("data-cowboy-mode", String(enabled));
  localStorage.setItem(COWBOY_MODE_STORAGE_KEY, String(enabled));
  window.dispatchEvent(new Event(COWBOY_MODE_CHANGE_EVENT));
}

export function toggleCowboyMode(): boolean {
  const next = !getInitialCowboyMode();
  applyCowboyMode(next);
  return next;
}
