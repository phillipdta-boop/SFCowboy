// web/src/App.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import * as client from "./api/client.js";
import { App } from "./App.js";

vi.mock("./api/client.js");

const CURRENT_USER: client.CurrentUser = {
  id: "u1",
  organizationId: "o1",
  email: "a@example.com",
  name: "Ada",
  role: "admin",
};

beforeEach(() => {
  vi.mocked(client.fetchConnections).mockResolvedValue([]);
  vi.mocked(client.fetchCurrentUser).mockResolvedValue(CURRENT_USER);
  // Home (the "/" route) also fetches these on mount — previously unmocked because assertions ran
  // synchronously before Home's effect settled; now that assertions await the auth check via
  // findByRole, Home's own effect has time to run too, so it needs real resolved values.
  vi.mocked(client.fetchPipelines).mockResolvedValue([]);
  vi.mocked(client.fetchDeployments).mockResolvedValue([]);
});

describe("App", () => {
  it("renders navigation links for every top-level page", async () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );
    // App fetches the current user on mount before rendering the nav, so wait for it rather than
    // asserting synchronously (see App.tsx's checkedAuth gate).
    expect(await screen.findByRole("link", { name: /^home$/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /connections/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /pipelines/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^deployments$/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /history/i })).toBeInTheDocument();
  });

  it("renders a theme toggle in the nav", async () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );
    expect(await screen.findByRole("button", { name: /(dark|light) mode/i })).toBeInTheDocument();
  });

  it("widens the main content area on the New Deployment page, which needs room for a data table", async () => {
    render(
      <MemoryRouter initialEntries={["/deploy/new"]}>
        <App />
      </MemoryRouter>
    );
    await screen.findByRole("link", { name: /^home$/i });
    expect(document.querySelector("main")).toHaveClass("wide");
  });

  it("widens the main content area on a deployment detail page, which can also render the component table", async () => {
    vi.mocked(client.fetchMetadataTypes).mockResolvedValue([]);
    vi.mocked(client.fetchDeployment).mockResolvedValue({
      id: "d1", title: null, source_connection_id: "s", target_connection_id: "t", status: "pending",
      test_level: "NoTestRun", validate_only: 0, ignore_warnings: 0, allow_missing_files: 0, auto_update_package: 0, started_at: "2026-01-01T00:00:00.000Z", finished_at: null,
      error_detail: null, is_rollback_of: null, components_deployed: null, components_total: null, tests_completed: null, tests_total: null, run_by: null, components: [], run_tests: [], items: [], pipeline_run_id: null, coverage_percent: null, coverage_details: null, source_branch: null, target_branch: null, static_analysis_findings: null, scheduled_at: null, package_path: null, target_connection_type: "org",
    });
    render(
      <MemoryRouter initialEntries={["/deployments/d1"]}>
        <App />
      </MemoryRouter>
    );
    await screen.findByRole("link", { name: /^home$/i });
    expect(document.querySelector("main")).toHaveClass("wide");
  });

  it("keeps the default narrow main content area on other pages", async () => {
    render(
      <MemoryRouter initialEntries={["/connections"]}>
        <App />
      </MemoryRouter>
    );
    await screen.findByRole("link", { name: /^home$/i });
    expect(document.querySelector("main")).not.toHaveClass("wide");
  });
});
