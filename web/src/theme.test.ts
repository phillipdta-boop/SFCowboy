import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { THEME_STORAGE_KEY, getInitialTheme, applyTheme, toggleTheme } from "./theme.js";

function mockMatchMedia(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getInitialTheme", () => {
  it("returns the stored preference when one exists", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    mockMatchMedia(false);
    expect(getInitialTheme()).toBe("dark");
  });

  it("falls back to the OS preference when nothing is stored, dark", () => {
    mockMatchMedia(true);
    expect(getInitialTheme()).toBe("dark");
  });

  it("falls back to the OS preference when nothing is stored, light", () => {
    mockMatchMedia(false);
    expect(getInitialTheme()).toBe("light");
  });
});

describe("applyTheme", () => {
  it("sets data-theme on the document root and persists to localStorage", () => {
    applyTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });
});

describe("toggleTheme", () => {
  it("flips light to dark and persists it", () => {
    applyTheme("light");
    const next = toggleTheme();
    expect(next).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("flips dark to light and persists it", () => {
    applyTheme("dark");
    const next = toggleTheme();
    expect(next).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});
