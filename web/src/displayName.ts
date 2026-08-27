const STORAGE_KEY = "sfcowboy-display-name";

// A self-reported name kept per-browser in localStorage — attribution, not authentication. There
// is no login system, so this labels who ran a deployment without verifying it; anyone using this
// browser can set it to anything.
export function getDisplayName(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setDisplayName(name: string): void {
  try {
    const trimmed = name.trim();
    if (trimmed) {
      localStorage.setItem(STORAGE_KEY, trimmed);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Storage unavailable (private browsing, disabled storage, etc.) — attribution is
    // best-effort, so silently skip rather than breaking the page.
  }
}
