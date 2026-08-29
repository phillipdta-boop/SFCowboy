// web/src/pages/PipelineRunDetail.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import * as client from "../api/client.js";
import { PipelineRunDetail } from "./PipelineRunDetail.js";

vi.mock("../api/client.js");

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/pipelines/p1/runs/r1"]}>
      <Routes>
        <Route path="/pipelines/:pipelineId/runs/:runId" element={<PipelineRunDetail />} />
      </Routes>
    </MemoryRouter>
  );
}

function baseRun(overrides: Partial<client.PipelineRunDetail> = {}): client.PipelineRunDetail {
  return {
    id: "r1",
    pipelineId: "p1",
    title: "Batch 1",
    createdAt: "2026-01-01T00:00:00.000Z",
    componentList: [{ type: "ApexClass", fullName: "MyClass" }],
    connectionIds: ["c1", "c2", "c3"],
    trackComponentsIndependently: true,
    deployments: [],
    positions: [{ type: "ApexClass", fullName: "MyClass", stage: 0, reachedAt: null }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(client.fetchConnections).mockResolvedValue([
    { id: "c1", type: "org", nickname: "Dev", createdAt: "", lastUsedAt: null },
    { id: "c2", type: "org", nickname: "QA", createdAt: "", lastUsedAt: null },
    { id: "c3", type: "org", nickname: "Prod", createdAt: "", lastUsedAt: null },
  ]);
});

describe("PipelineRunDetail page", () => {
  it("shows every stage's nickname across the top", async () => {
    vi.mocked(client.fetchPipelineRun).mockResolvedValue(baseRun());
    renderPage();
    expect(await screen.findByText("Dev")).toBeInTheDocument();
    expect(screen.getByText("QA")).toBeInTheDocument();
    expect(screen.getByText("Prod")).toBeInTheDocument();
  });

  it("shows the component grid with a blank cell for a component still at stage 0", async () => {
    vi.mocked(client.fetchPipelineRun).mockResolvedValue(baseRun());
    renderPage();
    const cell = await screen.findByTestId("cell-ApexClass::MyClass-0");
    expect(cell).toHaveTextContent("");
  });

  it("shows a checkmark and timestamp for a component that has advanced past a stage", async () => {
    vi.mocked(client.fetchPipelineRun).mockResolvedValue(
      baseRun({
        positions: [{ type: "ApexClass", fullName: "MyClass", stage: 1, reachedAt: "2026-01-02T00:00:00.000Z" }],
      })
    );
    renderPage();
    const cell = await screen.findByTestId("cell-ApexClass::MyClass-0");
    expect(cell).toHaveTextContent("✓");
  });

  it("shows a failure marker for a component that failed the step it's currently stuck at", async () => {
    vi.mocked(client.fetchPipelineRun).mockResolvedValue(
      baseRun({
        deployments: [
          {
            id: "d1",
            stepIndex: 0,
            status: "failed",
            validateOnly: false,
            startedAt: "2026-01-01T00:00:00.000Z",
            finishedAt: "2026-01-01T00:05:00.000Z",
            errorDetail: null,
            items: [{ metadataType: "ApexClass", apiName: "MyClass", status: "failed" }],
          },
        ],
      })
    );
    renderPage();
    const cell = await screen.findByTestId("cell-ApexClass::MyClass-0");
    expect(cell).toHaveTextContent("✗");
  });

  it("enables Validate/Deploy on a hop only while at least one component is eligible for it", async () => {
    vi.mocked(client.fetchPipelineRun).mockResolvedValue(baseRun());
    renderPage();
    await screen.findByText("Dev");

    const hop0Deploy = screen.getAllByRole("button", { name: /^deploy$/i })[0];
    const hop1Deploy = screen.getAllByRole("button", { name: /^deploy$/i })[1];
    expect(hop0Deploy).not.toBeDisabled();
    expect(hop1Deploy).toBeDisabled();
  });

  it("deploys a hop and refetches the run", async () => {
    vi.mocked(client.fetchPipelineRun).mockResolvedValue(baseRun());
    vi.mocked(client.deployPipelineStep).mockResolvedValue({ deploymentId: "d1", skipped: false });
    renderPage();
    await screen.findByText("Dev");

    fireEvent.click(screen.getAllByRole("button", { name: /^deploy$/i })[0]);

    await waitFor(() => expect(client.deployPipelineStep).toHaveBeenCalledWith("r1", 0, { validateOnly: false, runBy: undefined }));
    await waitFor(() => expect(client.fetchPipelineRun).toHaveBeenCalledTimes(2));
  });

  it("validates a hop without advancing anyone", async () => {
    vi.mocked(client.fetchPipelineRun).mockResolvedValue(baseRun());
    vi.mocked(client.deployPipelineStep).mockResolvedValue({ deploymentId: "d1", skipped: false });
    renderPage();
    await screen.findByText("Dev");

    fireEvent.click(screen.getAllByRole("button", { name: /^validate$/i })[0]);

    await waitFor(() => expect(client.deployPipelineStep).toHaveBeenCalledWith("r1", 0, { validateOnly: true, runBy: undefined }));
  });

  it("shows a hop's most recent status and timestamp once it has a deployment", async () => {
    vi.mocked(client.fetchPipelineRun).mockResolvedValue(
      baseRun({
        deployments: [
          {
            id: "d1",
            stepIndex: 0,
            status: "succeeded",
            validateOnly: false,
            startedAt: "2026-01-01T00:00:00.000Z",
            finishedAt: "2026-01-01T00:05:00.000Z",
            errorDetail: null,
            items: [],
          },
        ],
        positions: [{ type: "ApexClass", fullName: "MyClass", stage: 1, reachedAt: "2026-01-01T00:05:00.000Z" }],
      })
    );
    renderPage();
    expect(await screen.findByText(/succeeded/i)).toBeInTheDocument();
  });

  it("links a hop with a deployment to that deployment's own detail page", async () => {
    vi.mocked(client.fetchPipelineRun).mockResolvedValue(
      baseRun({
        deployments: [
          {
            id: "d1",
            stepIndex: 0,
            status: "failed",
            validateOnly: false,
            startedAt: "2026-01-01T00:00:00.000Z",
            finishedAt: "2026-01-01T00:05:00.000Z",
            errorDetail: null,
            items: [{ metadataType: "ApexClass", apiName: "MyClass", status: "failed" }],
          },
        ],
      })
    );
    renderPage();
    const link = await screen.findByRole("link", { name: /view deployment/i });
    expect(link).toHaveAttribute("href", "/deployments/d1");
  });
});
