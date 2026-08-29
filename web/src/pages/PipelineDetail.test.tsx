// web/src/pages/PipelineDetail.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import * as client from "../api/client.js";
import { PipelineDetail } from "./PipelineDetail.js";

vi.mock("../api/client.js");

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/pipelines/p1"]}>
      <Routes>
        <Route path="/pipelines/:id" element={<PipelineDetail />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(client.fetchPipeline).mockResolvedValue({
    id: "p1",
    name: "Main Pipeline",
    connectionIds: ["c1", "c2"],
    status: "active",
    trackComponentsIndependently: true,
  });
  vi.mocked(client.fetchConnections).mockResolvedValue([
    { id: "c1", type: "org", nickname: "Dev", createdAt: "", lastUsedAt: null },
    { id: "c2", type: "org", nickname: "QA", createdAt: "", lastUsedAt: null },
  ]);
  vi.mocked(client.fetchPipelineRuns).mockResolvedValue([]);
  vi.mocked(client.fetchMetadataTypes).mockResolvedValue(["ApexClass"]);
});

describe("PipelineDetail page", () => {
  it("shows the pipeline's stage chips in order", async () => {
    renderPage();
    expect(await screen.findByText("Dev")).toBeInTheDocument();
    expect(screen.getByText("QA")).toBeInTheDocument();
  });

  it("shows an empty state and a New Run button in the Runs tab by default", async () => {
    renderPage();
    await screen.findByRole("heading", { name: /main pipeline/i });
    expect(screen.getByRole("button", { name: /new run/i })).toBeInTheDocument();
  });

  it("lists existing runs with their component-progress summary", async () => {
    vi.mocked(client.fetchPipelineRuns).mockResolvedValue([
      { id: "r1", pipelineId: "p1", title: "Batch 1", createdAt: "2026-01-01T00:00:00.000Z", componentCount: 3, componentsAtFinalStage: 1 },
    ]);
    renderPage();
    expect(await screen.findByText("Batch 1")).toBeInTheDocument();
    expect(screen.getByText(/1\s*\/\s*3/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /batch 1/i })).toHaveAttribute("href", "/pipelines/p1/runs/r1");
  });

  it("starts a new run: picks a type, loads the diff, selects a component, and submits", async () => {
    vi.mocked(client.fetchDiff).mockResolvedValue([{ type: "ApexClass", fullName: "MyClass", status: "added" }]);
    vi.mocked(client.createPipelineRun).mockResolvedValue({ id: "r2" });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /new run/i }));
    fireEvent.focus(screen.getByRole("combobox", { name: /metadata types/i }));
    fireEvent.mouseDown(screen.getByRole("option", { name: "ApexClass" }));
    fireEvent.click(screen.getByRole("button", { name: /load diff/i }));
    await screen.findByText("MyClass");

    fireEvent.click(screen.getByRole("checkbox", { name: "MyClass" }));
    fireEvent.click(screen.getByRole("button", { name: /^start run$/i }));

    await waitFor(() =>
      expect(client.createPipelineRun).toHaveBeenCalledWith("p1", {
        title: undefined,
        components: [{ type: "ApexClass", fullName: "MyClass" }],
      })
    );
  });

  it("switches to the Settings tab and toggles the tracking mode", async () => {
    vi.mocked(client.updatePipeline).mockResolvedValue({
      id: "p1",
      name: "Main Pipeline",
      connectionIds: ["c1", "c2"],
      status: "active",
      trackComponentsIndependently: false,
    });
    renderPage();

    fireEvent.click(await screen.findByRole("tab", { name: /settings/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /track components independently/i }));
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() =>
      expect(client.updatePipeline).toHaveBeenCalledWith("p1", {
        name: "Main Pipeline",
        connectionIds: ["c1", "c2"],
        trackComponentsIndependently: false,
      })
    );
  });
});
