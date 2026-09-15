import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBadge } from "./StatusBadge.js";
import { applyCowboyMode } from "../cowboyMode.js";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-cowboy-mode");
});

describe("StatusBadge", () => {
  it("capitalizes only the first word, not the whole label", () => {
    render(<StatusBadge status="rolled_back" />);
    expect(screen.getByText("Rolled back")).toBeInTheDocument();
  });

  it("color-codes success and failure differently", () => {
    const { container: successContainer } = render(<StatusBadge status="succeeded" />);
    const { container: failContainer } = render(<StatusBadge status="failed" />);
    expect(successContainer.querySelector(".status-label-success")).toBeInTheDocument();
    expect(failContainer.querySelector(".status-label-danger")).toBeInTheDocument();
  });

  it("renders an icon alongside the label", () => {
    const { container } = render(<StatusBadge status="succeeded" />);
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("adds the status's cowboy mark when Cowboy Mode is on", () => {
    applyCowboyMode(true);
    const { container } = render(<StatusBadge status="succeeded" />);
    expect(container.querySelector('[data-cowboy-glyph="horseshoe"]')).toBeInTheDocument();
  });

  it("gives in-progress statuses the mark that animates", () => {
    applyCowboyMode(true);
    const { container } = render(<StatusBadge status="deploying" />);
    expect(container.querySelector('[data-cowboy-glyph="rowel"]')).toBeInTheDocument();
  });

  it("shows no cowboy mark when Cowboy Mode is off", () => {
    const { container } = render(<StatusBadge status="succeeded" />);
    expect(container.querySelector("[data-cowboy-glyph]")).not.toBeInTheDocument();
  });
});
