import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CowboyModeToggle } from "./CowboyModeToggle.js";
import { COWBOY_MODE_STORAGE_KEY } from "./cowboyMode.js";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-cowboy-mode");
});

describe("CowboyModeToggle", () => {
  it("starts off by default", () => {
    render(<CowboyModeToggle />);
    expect(document.documentElement.getAttribute("data-cowboy-mode")).toBe("false");
    expect(screen.getByRole("button", { name: /turn on cowboy mode/i })).toHaveAttribute("aria-pressed", "false");
  });

  it("turns on Cowboy Mode on click and persists it", () => {
    render(<CowboyModeToggle />);
    fireEvent.click(screen.getByRole("button"));

    expect(document.documentElement.getAttribute("data-cowboy-mode")).toBe("true");
    expect(localStorage.getItem(COWBOY_MODE_STORAGE_KEY)).toBe("true");
    expect(screen.getByRole("button", { name: /turn off cowboy mode/i })).toHaveAttribute("aria-pressed", "true");
  });

  it("turns it back off on a second click", () => {
    render(<CowboyModeToggle />);
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByRole("button"));

    expect(document.documentElement.getAttribute("data-cowboy-mode")).toBe("false");
    expect(screen.getByRole("button", { name: /turn on cowboy mode/i })).toBeInTheDocument();
  });
});
