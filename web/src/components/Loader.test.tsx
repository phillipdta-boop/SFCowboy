import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { Loader } from "./Loader.js";
import { applyCowboyMode } from "../cowboyMode.js";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-cowboy-mode");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Loader", () => {
  it("renders the standard loader (progress bar + spinner) when Cowboy Mode is off", () => {
    render(<Loader />);
    expect(screen.getByRole("status")).toHaveClass("standard-loader");
    expect(document.querySelector(".standard-loader-bar-fill")).toBeInTheDocument();
  });

  it("shows a subtext line while loading", () => {
    render(<Loader />);
    expect(screen.getByText("Connecting to Salesforce…")).toBeInTheDocument();
  });

  it("cycles the subtext over time", () => {
    vi.useFakeTimers();
    render(<Loader />);
    expect(screen.getByText("Connecting to Salesforce…")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1800);
    });
    expect(screen.getByText("Resolving components…")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1800);
    });
    expect(screen.getByText("Checking deployment status…")).toBeInTheDocument();
  });

  it("renders the galloping loader when Cowboy Mode is on", () => {
    applyCowboyMode(true);
    render(<Loader />);
    expect(screen.getByRole("status")).toHaveClass("cowboy-loader");
  });

  it("passes the label through as the accessible name either way", () => {
    const { unmount } = render(<Loader label="Fetching pipeline…" />);
    expect(screen.getByRole("status", { name: "Fetching pipeline…" })).toBeInTheDocument();
    unmount();

    applyCowboyMode(true);
    render(<Loader label="Fetching pipeline…" />);
    expect(screen.getByRole("status", { name: "Fetching pipeline…" })).toBeInTheDocument();
  });
});
