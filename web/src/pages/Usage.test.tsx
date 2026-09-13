import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { Usage } from "./Usage.js";
import * as api from "../api/client.js";

vi.mock("../api/client.js");

describe("Usage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("renders the this-month and all-time breakdowns", async () => {
    vi.mocked(api.fetchMyUsage).mockResolvedValue({
      thisMonth: { succeeded: 3, failed: 1 },
      allTime: { succeeded: 12, failed: 2, rolled_back: 1 },
    });

    render(<Usage />);

    expect(await screen.findByText("This month")).toBeInTheDocument();
    expect(screen.getByText("All time")).toBeInTheDocument();
    expect(screen.getAllByText("Succeeded")).toHaveLength(2);
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("Rolled back")).toBeInTheDocument();
  });

  it("shows an error if the usage fetch fails", async () => {
    vi.mocked(api.fetchMyUsage).mockRejectedValue(new Error("usage fetch failed"));

    render(<Usage />);

    expect(await screen.findByText("usage fetch failed")).toBeInTheDocument();
  });
});
