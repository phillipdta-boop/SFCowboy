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
        error_detail: null, is_rollback_of: null, components_deployed: null, components_total: null, tests_completed: null, tests_total: null,
      },
    ]);
    vi.mocked(client.fetchConnections).mockResolvedValue([
      { id: "s", type: "org", nickname: "Dev", createdAt: "", lastUsedAt: null },
      { id: "t", type: "org", nickname: "QA", createdAt: "", lastUsedAt: null, orgType: "sandbox" },
    ]);
    render(
      <MemoryRouter>
        <History />
      </MemoryRouter>
    );

    const link = await screen.findByRole("link", { name: /succeeded/i });
    expect(link).toHaveAttribute("href", "/deployments/d1");
  });

  it("shows the deployment's name (falling back to source → target) and its source/target environments", async () => {
    vi.mocked(client.fetchDeployments).mockResolvedValue([
      {
        id: "d1", title: "Sprint 12 release", source_connection_id: "s", target_connection_id: "t", status: "succeeded",
        test_level: "NoTestRun", validate_only: 0, ignore_warnings: 0, allow_missing_files: 0, auto_update_package: 0, started_at: "2026-01-01T00:00:00.000Z", finished_at: "2026-01-01T00:01:00.000Z",
        error_detail: null, is_rollback_of: null, components_deployed: null, components_total: null, tests_completed: null, tests_total: null,
      },
      {
        id: "d2", title: null, source_connection_id: "s", target_connection_id: "t", status: "failed",
        test_level: "NoTestRun", validate_only: 0, ignore_warnings: 0, allow_missing_files: 0, auto_update_package: 0, started_at: "2026-01-02T00:00:00.000Z", finished_at: "2026-01-02T00:01:00.000Z",
        error_detail: null, is_rollback_of: null, components_deployed: null, components_total: null, tests_completed: null, tests_total: null,
      },
    ]);
    vi.mocked(client.fetchConnections).mockResolvedValue([
      { id: "s", type: "org", nickname: "DevSpare", createdAt: "", lastUsedAt: null, orgType: "production" },
      { id: "t", type: "org", nickname: "EffDevTest", createdAt: "", lastUsedAt: null, orgType: "sandbox" },
    ]);
    render(
      <MemoryRouter>
        <History />
      </MemoryRouter>
    );

    expect(await screen.findByRole("link", { name: "Sprint 12 release" })).toHaveAttribute("href", "/deployments/d1");
    expect(await screen.findByRole("link", { name: "DevSpare → EffDevTest" })).toHaveAttribute("href", "/deployments/d2");
    expect(screen.getAllByText("DevSpare")).toHaveLength(2);
    expect(screen.getAllByText("EffDevTest")).toHaveLength(2);
    expect(screen.getAllByText("Production")).toHaveLength(2);
    expect(screen.getAllByText("Sandbox")).toHaveLength(2);
  });

  it("surfaces an error when the initial load fails, rather than silently showing an empty table", async () => {
    vi.mocked(client.fetchDeployments).mockRejectedValue(new Error("service unavailable"));
    vi.mocked(client.fetchConnections).mockResolvedValue([]);
    render(
      <MemoryRouter>
        <History />
      </MemoryRouter>
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("service unavailable");
  });
});
