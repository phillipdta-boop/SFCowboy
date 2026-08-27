// web/src/pages/History.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import * as client from "../api/client.js";
import { History } from "./History.js";

vi.mock("../api/client.js");

describe("History page", () => {
  it("lists past deployments with a link to each detail page", async () => {
    vi.mocked(client.fetchDeployments).mockResolvedValue([
      {
        id: "d1", title: null, source_connection_id: "s", target_connection_id: "t", status: "succeeded",
        test_level: "NoTestRun", validate_only: 0, ignore_warnings: 0, allow_missing_files: 0, auto_update_package: 0, started_at: "2026-01-01T00:00:00.000Z", finished_at: "2026-01-01T00:01:00.000Z",
        error_detail: null, is_rollback_of: null,
      },
    ]);
    render(
      <MemoryRouter>
        <History />
      </MemoryRouter>
    );

    const link = await screen.findByRole("link", { name: /succeeded/i });
    expect(link).toHaveAttribute("href", "/deployments/d1");
  });

  it("surfaces an error when the initial load fails, rather than silently showing an empty table", async () => {
    vi.mocked(client.fetchDeployments).mockRejectedValue(new Error("service unavailable"));
    render(
      <MemoryRouter>
        <History />
      </MemoryRouter>
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("service unavailable");
  });
});
