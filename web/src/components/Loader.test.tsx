import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { Loader } from "./Loader.js";
import { applyCowboyMode } from "../cowboyMode.js";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-cowboy-mode");
});

describe("Loader", () => {
  it("renders the plain spinner when Cowboy Mode is off", () => {
    render(<Loader />);
    expect(screen.getByRole("status")).toHaveClass("spinner");
  });

  it("renders the galloping loader when Cowboy Mode is on", () => {
    applyCowboyMode(true);
    render(<Loader />);
    expect(screen.getByRole("status")).toHaveClass("cowboy-loader");
  });

  it("passes the label through as the accessible name either way", () => {
    applyCowboyMode(true);
    render(<Loader label="Fetching pipeline…" />);
    expect(screen.getByRole("status", { name: "Fetching pipeline…" })).toBeInTheDocument();
  });
});
