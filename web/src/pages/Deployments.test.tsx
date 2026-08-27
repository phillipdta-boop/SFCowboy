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
    id: "d1", source_connection_id: "src1", target_connection_id: "tgt1", status: "succeeded",
    test_level: "NoTestRun", validate_only: 0, started_at: "2026-01-01T00:00:00.000Z", finished_at: "2026-01-01T00:01:00.000Z",
    error_detail: null, is_rollback_of: null,
  },
  {
    id: "d2", source_connection_id: "src1", target_connection_id: "tgt1", status: "failed",
    test_level: "NoTestRun", validate_only: 0, started_at: "2026-02-01T00:00:00.000Z", finished_at: "2026-02-01T00:01:00.000Z",
    error_detail: "boom", is_rollback_of: null,
  },
];

function setup() {
  vi.mocked(client.fetchDeployments).mockResolvedValue(DEPLOYMENTS);
  vi.mocked(client.fetchConnections).mockResolvedValue([
    { id: "src1", type: "org", nickname: "DevSpare", createdAt: "", lastUsedAt: null },
    { id: "tgt1", type: "org", nickname: "EffDevTest", createdAt: "", lastUsedAt: null },
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

  it("renders columns for Deployment, Source, Target, Last Status, and Created Date", async () => {
    setup();
    renderPage();
    await screen.findAllByText("DevSpare → EffDevTest");
    expect(screen.getByRole("columnheader", { name: /deployment/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /^source/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /^target/i })).toBeInTheDocument();
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

  it("shows Last Status as a badge", async () => {
    setup();
    renderPage();
    await screen.findAllByText("DevSpare → EffDevTest");
    expect(screen.getByText("succeeded")).toHaveClass("badge");
    expect(screen.getByText("failed")).toHaveClass("badge");
  });

  it("sorts rows by Created Date, newest last by default reversed on click", async () => {
    setup();
    renderPage();
    await screen.findByText("succeeded");

    fireEvent.click(within(screen.getByRole("columnheader", { name: /created date/i })).getByRole("button"));
    let statuses = screen.getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[3].textContent);
    expect(statuses).toEqual(["succeeded", "failed"]);

    fireEvent.click(within(screen.getByRole("columnheader", { name: /created date/i })).getByRole("button"));
    statuses = screen.getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[3].textContent);
    expect(statuses).toEqual(["failed", "succeeded"]);
  });

  it("surfaces an error when the initial load fails, rather than silently showing an empty table", async () => {
    vi.mocked(client.fetchDeployments).mockRejectedValue(new Error("service unavailable"));
    vi.mocked(client.fetchConnections).mockResolvedValue([]);
    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent("service unavailable");
  });
});
