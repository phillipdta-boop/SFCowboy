import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProgressBar } from "./ProgressBar.js";

describe("ProgressBar", () => {
  it("shows the label and the raw X / Y count", () => {
    render(<ProgressBar label="Components" value={2} max={5} />);
    expect(screen.getByText("Components")).toBeInTheDocument();
    expect(screen.getByText("2 / 5")).toBeInTheDocument();
  });

  it("exposes the fraction as an accessible progressbar", () => {
    render(<ProgressBar label="Apex tests" value={3} max={10} />);
    const bar = screen.getByRole("progressbar", { name: "Apex tests" });
    expect(bar).toHaveAttribute("aria-valuenow", "3");
    expect(bar).toHaveAttribute("aria-valuemax", "10");
  });

  it("doesn't divide by zero when max is 0", () => {
    render(<ProgressBar label="Apex tests" value={0} max={0} />);
    expect(screen.getByText("0 / 0")).toBeInTheDocument();
  });
});
