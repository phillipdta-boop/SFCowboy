// web/src/pages/History.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
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
        error_detail: null, is_rollback_of: null, components_deployed: null, components_total: null, tests_completed: null, tests_total: null, run_by: null, items: [], pipeline_run_id: null, coverage_percent: null, coverage_details: null,
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
        error_detail: null, is_rollback_of: null, components_deployed: null, components_total: null, tests_completed: null, tests_total: null, run_by: null, items: [], pipeline_run_id: null, coverage_percent: null, coverage_details: null,
      },
      {
        id: "d2", title: null, source_connection_id: "s", target_connection_id: "t", status: "failed",
        test_level: "NoTestRun", validate_only: 0, ignore_warnings: 0, allow_missing_files: 0, auto_update_package: 0, started_at: "2026-01-02T00:00:00.000Z", finished_at: "2026-01-02T00:01:00.000Z",
        error_detail: null, is_rollback_of: null, components_deployed: null, components_total: null, tests_completed: null, tests_total: null, run_by: null, items: [], pipeline_run_id: null, coverage_percent: null, coverage_details: null,
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

  it("shows who ran each deployment, falling back to an em dash when nobody is attributed", async () => {
    vi.mocked(client.fetchDeployments).mockResolvedValue([
      {
        id: "d1", title: null, source_connection_id: "s", target_connection_id: "t", status: "succeeded",
        test_level: "NoTestRun", validate_only: 0, ignore_warnings: 0, allow_missing_files: 0, auto_update_package: 0, started_at: "2026-01-01T00:00:00.000Z", finished_at: "2026-01-01T00:01:00.000Z",
        error_detail: null, is_rollback_of: null, components_deployed: null, components_total: null, tests_completed: null, tests_total: null, run_by: "Phillip", items: [], pipeline_run_id: null, coverage_percent: null, coverage_details: null,
      },
      {
        id: "d2", title: null, source_connection_id: "s", target_connection_id: "t", status: "pending",
        test_level: "NoTestRun", validate_only: 0, ignore_warnings: 0, allow_missing_files: 0, auto_update_package: 0, started_at: "2026-01-02T00:00:00.000Z", finished_at: null,
        error_detail: null, is_rollback_of: null, components_deployed: null, components_total: null, tests_completed: null, tests_total: null, run_by: null, items: [], pipeline_run_id: null, coverage_percent: null, coverage_details: null,
      },
    ]);
    vi.mocked(client.fetchConnections).mockResolvedValue([
      { id: "s", type: "org", nickname: "Dev", createdAt: "", lastUsedAt: null },
      { id: "t", type: "org", nickname: "QA", createdAt: "", lastUsedAt: null },
    ]);
    render(
      <MemoryRouter>
        <History />
      </MemoryRouter>
    );

    await screen.findByText("Phillip");
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("lists a run's components under a collapsed-by-default summary of how many there are", async () => {
    vi.mocked(client.fetchDeployments).mockResolvedValue([
      {
        id: "d1", title: null, source_connection_id: "s", target_connection_id: "t", status: "succeeded",
        test_level: "NoTestRun", validate_only: 0, ignore_warnings: 0, allow_missing_files: 0, auto_update_package: 0, started_at: "2026-01-01T00:00:00.000Z", finished_at: "2026-01-01T00:01:00.000Z",
        error_detail: null, is_rollback_of: null, components_deployed: null, components_total: null, tests_completed: null, tests_total: null, run_by: null,
        items: [
          { metadata_type: "ApexClass", api_name: "MyClass", action: "modify", status: "succeeded", error_message: null },
          { metadata_type: "CustomObject", api_name: "Account", action: "modify", status: "succeeded", error_message: null },
        ],
        pipeline_run_id: null, coverage_percent: null, coverage_details: null,
      },
    ]);
    vi.mocked(client.fetchConnections).mockResolvedValue([
      { id: "s", type: "org", nickname: "Dev", createdAt: "", lastUsedAt: null },
      { id: "t", type: "org", nickname: "QA", createdAt: "", lastUsedAt: null },
    ]);
    render(
      <MemoryRouter>
        <History />
      </MemoryRouter>
    );

    const summary = await screen.findByText("2 components");
    const details = summary.closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    // Collapsed content stays in the DOM, just not exposed via role queries — findByText still
    // finds it, matching the same convention used for the deployment status panel.
    expect(screen.getByText(/ApexClass MyClass/)).toBeInTheDocument();
    expect(screen.getByText(/CustomObject Account/)).toBeInTheDocument();
  });

  it("shows a singular label and no items for a run with exactly one or zero components", async () => {
    vi.mocked(client.fetchDeployments).mockResolvedValue([
      {
        id: "d1", title: null, source_connection_id: "s", target_connection_id: "t", status: "succeeded",
        test_level: "NoTestRun", validate_only: 0, ignore_warnings: 0, allow_missing_files: 0, auto_update_package: 0, started_at: "2026-01-01T00:00:00.000Z", finished_at: "2026-01-01T00:01:00.000Z",
        error_detail: null, is_rollback_of: null, components_deployed: null, components_total: null, tests_completed: null, tests_total: null, run_by: null,
        items: [{ metadata_type: "ApexClass", api_name: "MyClass", action: "modify", status: "succeeded", error_message: null }],
        pipeline_run_id: null, coverage_percent: null, coverage_details: null,
      },
      {
        id: "d2", title: null, source_connection_id: "s", target_connection_id: "t", status: "pending",
        test_level: "NoTestRun", validate_only: 0, ignore_warnings: 0, allow_missing_files: 0, auto_update_package: 0, started_at: "2026-01-02T00:00:00.000Z", finished_at: null,
        error_detail: null, is_rollback_of: null, components_deployed: null, components_total: null, tests_completed: null, tests_total: null, run_by: null,
        items: [],
        pipeline_run_id: null, coverage_percent: null, coverage_details: null,
      },
    ]);
    vi.mocked(client.fetchConnections).mockResolvedValue([
      { id: "s", type: "org", nickname: "Dev", createdAt: "", lastUsedAt: null },
      { id: "t", type: "org", nickname: "QA", createdAt: "", lastUsedAt: null },
    ]);
    render(
      <MemoryRouter>
        <History />
      </MemoryRouter>
    );

    expect(await screen.findByText("1 component")).toBeInTheDocument();
    expect(screen.getByText("0 components")).toBeInTheDocument();
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

  it("shows a loading spinner instead of an empty table while the initial fetch is in flight", async () => {
    vi.mocked(client.fetchDeployments).mockResolvedValue([]);
    vi.mocked(client.fetchConnections).mockResolvedValue([]);
    render(
      <MemoryRouter>
        <History />
      </MemoryRouter>
    );

    expect(screen.getByRole("status", { name: /loading/i })).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("status", { name: /loading/i })).not.toBeInTheDocument());
  });

  it("still lists a deployment tagged to a pipeline run, unlike the Deployments page", async () => {
    vi.mocked(client.fetchDeployments).mockResolvedValue([
      {
        id: "d1", title: null, source_connection_id: "s", target_connection_id: "t", status: "succeeded",
        test_level: "NoTestRun", validate_only: 0, ignore_warnings: 0, allow_missing_files: 0, auto_update_package: 0, started_at: "2026-01-01T00:00:00.000Z", finished_at: "2026-01-01T00:01:00.000Z",
        error_detail: null, is_rollback_of: null, components_deployed: null, components_total: null, tests_completed: null, tests_total: null, run_by: null, items: [], pipeline_run_id: "run1", coverage_percent: null, coverage_details: null,
      },
    ]);
    vi.mocked(client.fetchConnections).mockResolvedValue([
      { id: "s", type: "org", nickname: "Dev", createdAt: "", lastUsedAt: null },
      { id: "t", type: "org", nickname: "QA", createdAt: "", lastUsedAt: null },
    ]);
    render(
      <MemoryRouter>
        <History />
      </MemoryRouter>
    );

    expect(await screen.findByRole("link", { name: /succeeded/i })).toHaveAttribute("href", "/deployments/d1");
  });

  it("sorts rows by Started, reversed on a second click of the same header", async () => {
    vi.mocked(client.fetchDeployments).mockResolvedValue([
      {
        id: "d1", title: null, source_connection_id: "s", target_connection_id: "t", status: "succeeded",
        test_level: "NoTestRun", validate_only: 0, ignore_warnings: 0, allow_missing_files: 0, auto_update_package: 0, started_at: "2026-01-01T00:00:00.000Z", finished_at: "2026-01-01T00:01:00.000Z",
        error_detail: null, is_rollback_of: null, components_deployed: null, components_total: null, tests_completed: null, tests_total: null, run_by: null, items: [], pipeline_run_id: null, coverage_percent: null, coverage_details: null,
      },
      {
        id: "d2", title: null, source_connection_id: "s", target_connection_id: "t", status: "failed",
        test_level: "NoTestRun", validate_only: 0, ignore_warnings: 0, allow_missing_files: 0, auto_update_package: 0, started_at: "2026-02-01T00:00:00.000Z", finished_at: "2026-02-01T00:01:00.000Z",
        error_detail: null, is_rollback_of: null, components_deployed: null, components_total: null, tests_completed: null, tests_total: null, run_by: null, items: [], pipeline_run_id: null, coverage_percent: null, coverage_details: null,
      },
    ]);
    vi.mocked(client.fetchConnections).mockResolvedValue([
      { id: "s", type: "org", nickname: "Dev", createdAt: "", lastUsedAt: null },
      { id: "t", type: "org", nickname: "QA", createdAt: "", lastUsedAt: null },
    ]);
    render(
      <MemoryRouter>
        <History />
      </MemoryRouter>
    );

    await screen.findByText("Succeeded");
    fireEvent.click(within(screen.getByRole("columnheader", { name: /started/i })).getByRole("button"));
    let statuses = screen.getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[3].textContent);
    expect(statuses).toEqual(["Succeeded", "Failed"]);

    fireEvent.click(within(screen.getByRole("columnheader", { name: /started/i })).getByRole("button"));
    statuses = screen.getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[3].textContent);
    expect(statuses).toEqual(["Failed", "Succeeded"]);
  });
});
