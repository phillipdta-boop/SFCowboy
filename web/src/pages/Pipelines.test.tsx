// web/src/pages/Pipelines.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import * as client from "../api/client.js";
import { Pipelines } from "./Pipelines.js";

vi.mock("../api/client.js");

beforeEach(() => {
  vi.mocked(client.fetchConnections).mockResolvedValue([
    { id: "1", type: "org", nickname: "Dev", createdAt: "", lastUsedAt: null },
    { id: "2", type: "org", nickname: "QA", createdAt: "", lastUsedAt: null },
  ]);
  vi.mocked(client.fetchPipelines).mockResolvedValue([
    { id: "p1", name: "Main", connectionIds: ["1", "2"], status: "active", trackComponentsIndependently: true },
  ]);
  vi.mocked(client.fetchPipelineRuns).mockResolvedValue([]);
});

function renderPage() {
  return render(
    <MemoryRouter>
      <Pipelines />
    </MemoryRouter>
  );
}

describe("Pipelines page", () => {
  it("lists existing pipelines with resolved connection nicknames and their type icons", async () => {
    renderPage();
    expect(await screen.findByText("Main")).toBeInTheDocument();
    expect(screen.getByText("Dev")).toBeInTheDocument();
    expect(screen.getByText("QA")).toBeInTheDocument();
  });

  it("links each pipeline's name to its detail page", async () => {
    renderPage();
    const link = await screen.findByRole("link", { name: "Main" });
    expect(link).toHaveAttribute("href", "/pipelines/p1");
  });

  it("links to a dedicated New Pipeline page instead of an inline form", async () => {
    renderPage();
    const link = await screen.findByRole("link", { name: /new pipeline/i });
    expect(link).toHaveAttribute("href", "/pipelines/new");
    expect(screen.queryByLabelText(/pipeline name/i)).not.toBeInTheDocument();
  });

  it("shows a status badge and a Close toggle button for an active pipeline", async () => {
    renderPage();
    await screen.findByText("Main");
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /close/i })).toBeInTheDocument();
  });

  it("closes a pipeline via the toggle button", async () => {
    vi.mocked(client.updatePipelineStatus).mockResolvedValue({
      id: "p1",
      name: "Main",
      connectionIds: ["1", "2"],
      status: "closed",
      trackComponentsIndependently: true,
    });
    renderPage();
    await screen.findByText("Main");

    fireEvent.click(screen.getByRole("button", { name: /close/i }));

    await waitFor(() => expect(client.updatePipelineStatus).toHaveBeenCalledWith("p1", "closed"));
  });

  it("shows a Reopen button for a closed pipeline", async () => {
    vi.mocked(client.fetchPipelines).mockResolvedValue([
      { id: "p1", name: "Main", connectionIds: ["1", "2"], status: "closed", trackComponentsIndependently: true },
    ]);
    renderPage();
    await screen.findByText("Main");
    expect(screen.getByText("closed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reopen/i })).toBeInTheDocument();
  });

  it("shows 'No runs yet' for a pipeline with no runs", async () => {
    renderPage();
    expect(await screen.findByText("No runs yet")).toBeInTheDocument();
  });

  it("shows the most recent run's progress for a pipeline with runs", async () => {
    vi.mocked(client.fetchPipelineRuns).mockResolvedValue([
      { id: "r2", pipelineId: "p1", title: "Second", createdAt: "2026-01-02T00:00:00.000Z", componentCount: 3, componentsAtFinalStage: 1 },
      { id: "r1", pipelineId: "p1", title: "First", createdAt: "2026-01-01T00:00:00.000Z", componentCount: 2, componentsAtFinalStage: 2 },
    ]);
    renderPage();
    expect(await screen.findByText(/Latest run: 1 \/ 3 at final stage/)).toBeInTheDocument();
  });
});
