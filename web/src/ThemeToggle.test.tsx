import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ThemeToggle } from "./ThemeToggle.js";
import { THEME_STORAGE_KEY } from "./theme.js";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ThemeToggle", () => {
  it("renders starting from the initial theme and labels itself for the mode it will switch to", () => {
    render(<ThemeToggle />);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(screen.getByRole("button", { name: /dark mode/i })).toBeInTheDocument();
  });

  it("switches to dark mode on click, persists it, and flips its own label", () => {
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole("button", { name: /dark mode/i }));

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(screen.getByRole("button", { name: /light mode/i })).toBeInTheDocument();
  });

  it("switches back to light mode on a second click", () => {
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole("button", { name: /dark mode/i }));
    fireEvent.click(screen.getByRole("button", { name: /light mode/i }));

    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(screen.getByRole("button", { name: /dark mode/i })).toBeInTheDocument();
  });
});
