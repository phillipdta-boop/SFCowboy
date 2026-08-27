import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBadge } from "./StatusBadge.js";

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
});
