// web/src/pages/Home.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import * as client from "../api/client.js";
import { Home } from "./Home.js";

vi.mock("../api/client.js");

beforeEach(() => {
  vi.mocked(client.fetchConnections).mockResolvedValue([
    { id: "1", type: "org", nickname: "Dev Sandbox", createdAt: "2026-01-01", lastUsedAt: null, orgType: "sandbox" },
    { id: "2", type: "git", nickname: "Repo", createdAt: "2026-01-01", lastUsedAt: null, remoteUrl: "https://github.com/x/y.git" },
  ]);
  vi.mocked(client.fetchPipelines).mockResolvedValue([
    { id: "p1", name: "Main", connectionIds: ["1", "2"], status: "active" },
    { id: "p2", name: "Old", connectionIds: ["1"], status: "closed" },
  ]);
  vi.mocked(client.fetchDeployments).mockResolvedValue([
    {
      id: "d1",
      title: null,
      source_connection_id: "1",
      target_connection_id: "2",
      status: "succeeded",
      test_level: "NoTestRun",
      validate_only: 0,
      ignore_warnings: 0,
      allow_missing_files: 0,
      auto_update_package: 0,
      started_at: "2026-08-20T10:00:00Z",
      finished_at: "2026-08-20T10:05:00Z",
      error_detail: null,
      is_rollback_of: null,
    },
  ]);
});

function renderPage() {
  return render(
    <MemoryRouter>
      <Home />
    </MemoryRouter>
  );
}

describe("Home page", () => {
  it("summarizes recent deployments, connections, and pipelines", async () => {
    renderPage();
    expect(await screen.findByText(/succeeded/i)).toBeInTheDocument();
    expect(screen.getByText("Dev Sandbox")).toBeInTheDocument();
    expect(screen.getByText("Repo")).toBeInTheDocument();
    expect(screen.getByText("Main")).toBeInTheDocument();
  });

  it("defaults to showing only active pipelines, and can filter to closed", async () => {
    renderPage();
    await screen.findByText("Main");
    expect(screen.queryByText("Old")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /closed/i }));
    await waitFor(() => expect(screen.getByText("Old")).toBeInTheDocument());
    expect(screen.queryByText("Main")).not.toBeInTheDocument();
  });

  it("can switch back to the active filter", async () => {
    renderPage();
    await screen.findByText("Main");

    fireEvent.click(screen.getByRole("button", { name: /closed/i }));
    await waitFor(() => expect(screen.getByText("Old")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /^active$/i }));
    await waitFor(() => expect(screen.getByText("Main")).toBeInTheDocument());
    expect(screen.queryByText("Old")).not.toBeInTheDocument();
  });
});
