// web/src/pages/Deployments.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import * as client from "../api/client.js";
import type { DeploymentSummary } from "../api/client.js";
import { Deployments } from "./Deployments.js";

vi.mock("../api/client.js");

const DEPLOYMENTS: DeploymentSummary[] = [
  {
    id: "d1", title: null, source_connection_id: "src1", target_connection_id: "tgt1", status: "succeeded",
    test_level: "NoTestRun", validate_only: 0, ignore_warnings: 0, allow_missing_files: 0, auto_update_package: 0, started_at: "2026-01-01T00:00:00.000Z", finished_at: "2026-01-01T00:01:00.000Z",
    error_detail: null, is_rollback_of: null, components_deployed: null, components_total: null, tests_completed: null, tests_total: null, run_by: null, items: [], pipeline_run_id: null,
  },
  {
    id: "d2", title: null, source_connection_id: "src1", target_connection_id: "tgt1", status: "failed",
    test_level: "NoTestRun", validate_only: 0, ignore_warnings: 0, allow_missing_files: 0, auto_update_package: 0, started_at: "2026-02-01T00:00:00.000Z", finished_at: "2026-02-01T00:01:00.000Z",
    error_detail: "boom", is_rollback_of: null, components_deployed: null, components_total: null, tests_completed: null, tests_total: null, run_by: null, items: [], pipeline_run_id: null,
  },
];

function setup() {
  vi.mocked(client.fetchDeployments).mockResolvedValue(DEPLOYMENTS);
  vi.mocked(client.fetchConnections).mockResolvedValue([
    { id: "src1", type: "org", nickname: "DevSpare", createdAt: "", lastUsedAt: null, orgType: "sandbox" },
    { id: "tgt1", type: "org", nickname: "EffDevTest", createdAt: "", lastUsedAt: null, orgType: "sandbox" },
  ]);
}

function renderPage() {
  return render(
    <MemoryRouter>
      <Deployments />
    </MemoryRouter>
  );
}

describe("Deployments page", () => {
  it("shows a New Deployment link at the top", async () => {
    setup();
    renderPage();
    const link = await screen.findByRole("link", { name: /new deployment/i });
    expect(link).toHaveAttribute("href", "/deploy/new");
  });

  it("renders columns for Deployment, Environments, Last Status, and Created Date", async () => {
    setup();
    renderPage();
    await screen.findAllByText("DevSpare → EffDevTest");
    expect(screen.getByRole("columnheader", { name: /deployment/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /environments/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /last status/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /created date/i })).toBeInTheDocument();
  });

  it("labels each row as source → target and links it to the deployment's detail page", async () => {
    setup();
    renderPage();
    const links = await screen.findAllByRole("link", { name: "DevSpare → EffDevTest" });
    const hrefs = links.map((l) => l.getAttribute("href"));
    expect(hrefs).toEqual(expect.arrayContaining(["/deployments/d1", "/deployments/d2"]));
  });

  it("shows the source and target names with a directional arrow between them in the Environments column", async () => {
    setup();
    renderPage();
    await screen.findAllByText("DevSpare");
    const rows = screen.getAllByRole("row");
    const envCell = within(rows[1]).getAllByRole("cell")[1];
    expect(within(envCell).getByText("DevSpare")).toBeInTheDocument();
    expect(within(envCell).getByText("EffDevTest")).toBeInTheDocument();
    expect(within(envCell).getByText("→")).toBeInTheDocument();
  });

  it("flags a sandbox environment with a Sandbox badge and a production one with a Production badge", async () => {
    vi.mocked(client.fetchDeployments).mockResolvedValue(DEPLOYMENTS);
    vi.mocked(client.fetchConnections).mockResolvedValue([
      { id: "src1", type: "org", nickname: "DevSpare", createdAt: "", lastUsedAt: null, orgType: "sandbox" },
      { id: "tgt1", type: "org", nickname: "EffProd", createdAt: "", lastUsedAt: null, orgType: "production" },
    ]);
    renderPage();

    await screen.findAllByText("DevSpare");
    const rows = screen.getAllByRole("row");
    const envCell = within(rows[1]).getAllByRole("cell")[1];
    expect(within(envCell).getByText("Sandbox")).toBeInTheDocument();
    const productionBadge = within(envCell).getByText("Production");
    expect(productionBadge).toHaveClass("badge-removed");
  });

  it("labels a git connection with a Git badge instead of guessing an org type", async () => {
    vi.mocked(client.fetchDeployments).mockResolvedValue(DEPLOYMENTS);
    vi.mocked(client.fetchConnections).mockResolvedValue([
      { id: "src1", type: "org", nickname: "DevSpare", createdAt: "", lastUsedAt: null, orgType: "sandbox" },
      { id: "tgt1", type: "git", nickname: "ReleaseRepo", createdAt: "", lastUsedAt: null },
    ]);
    renderPage();

    await screen.findAllByText("DevSpare");
    const rows = screen.getAllByRole("row");
    const envCell = within(rows[1]).getAllByRole("cell")[1];
    expect(within(envCell).getByText("Git")).toBeInTheDocument();
  });

  it("shows Last Status as a color-coded, capitalized badge with an icon", async () => {
    setup();
    renderPage();
    await screen.findAllByText("DevSpare → EffDevTest");
    expect(screen.getByText("Succeeded")).toHaveClass("status-label-success");
    expect(screen.getByText("Failed")).toHaveClass("status-label-danger");
  });

  it("sorts rows by Created Date, newest last by default reversed on click", async () => {
    setup();
    renderPage();
    await screen.findByText("Succeeded");

    fireEvent.click(within(screen.getByRole("columnheader", { name: /created date/i })).getByRole("button"));
    let statuses = screen.getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[2].textContent);
    expect(statuses).toEqual(["Succeeded", "Failed"]);

    fireEvent.click(within(screen.getByRole("columnheader", { name: /created date/i })).getByRole("button"));
    statuses = screen.getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[2].textContent);
    expect(statuses).toEqual(["Failed", "Succeeded"]);
  });

  it("labels a row with its title instead of source → target when a title is set", async () => {
    vi.mocked(client.fetchDeployments).mockResolvedValue([
      { ...DEPLOYMENTS[0], title: "Sprint 12 release" },
      DEPLOYMENTS[1],
    ]);
    vi.mocked(client.fetchConnections).mockResolvedValue([
      { id: "src1", type: "org", nickname: "DevSpare", createdAt: "", lastUsedAt: null, orgType: "sandbox" },
      { id: "tgt1", type: "org", nickname: "EffDevTest", createdAt: "", lastUsedAt: null, orgType: "sandbox" },
    ]);
    renderPage();

    const link = await screen.findByRole("link", { name: "Sprint 12 release" });
    expect(link).toHaveAttribute("href", "/deployments/d1");
  });

  it("surfaces an error when the initial load fails, rather than silently showing an empty table", async () => {
    vi.mocked(client.fetchDeployments).mockRejectedValue(new Error("service unavailable"));
    vi.mocked(client.fetchConnections).mockResolvedValue([]);
    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent("service unavailable");
  });

  it("shows a loading spinner instead of an empty table while the initial fetch is in flight", async () => {
    setup();
    renderPage();
    expect(screen.getByRole("status", { name: /loading/i })).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    await screen.findByRole("table");
  });

  // A deployment tagged to a pipeline run is a hop that's already visible on that run's own page —
  // listing it here too would mean the same in-flight work appears in two places with two
  // different action surfaces (this page's editor vs. the run's Validate/Deploy buttons).
  it("excludes deployments that were started as a pipeline step", async () => {
    vi.mocked(client.fetchDeployments).mockResolvedValue([
      ...DEPLOYMENTS,
      {
        ...DEPLOYMENTS[0],
        id: "d3",
        pipeline_run_id: "run1",
      },
    ]);
    vi.mocked(client.fetchConnections).mockResolvedValue([
      { id: "src1", type: "org", nickname: "DevSpare", createdAt: "", lastUsedAt: null, orgType: "sandbox" },
      { id: "tgt1", type: "org", nickname: "EffDevTest", createdAt: "", lastUsedAt: null, orgType: "sandbox" },
    ]);
    renderPage();

    await screen.findAllByText("DevSpare → EffDevTest");
    expect(screen.getAllByRole("row")).toHaveLength(3); // header + d1 + d2, not d3
  });
});
