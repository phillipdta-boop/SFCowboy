// web/src/pages/PipelineRunDetail.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import * as client from "../api/client.js";
import { PipelineRunDetail } from "./PipelineRunDetail.js";
import { applyCowboyMode } from "../cowboyMode.js";

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
  localStorage.clear();
  document.documentElement.removeAttribute("data-cowboy-mode");
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
    // "Dev"/"QA"/"Prod" legitimately render twice each — once in the stepper across the top,
    // once as a column header in the grid below — so this checks presence via getAllByText
    // rather than the singular query, which throws on more than one match.
    expect((await screen.findAllByText("Dev")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("QA").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Prod").length).toBeGreaterThan(0);
  });

  it("shows the component grid with a blank cell for a component still at stage 0", async () => {
    vi.mocked(client.fetchPipelineRun).mockResolvedValue(baseRun());
    renderPage();
    const cell = await screen.findByTestId("cell-ApexClass::MyClass-0");
    expect(cell).toHaveTextContent("");
  });

  it("filters the component grid by the Component column's filter box, leaving stage columns unaffected", async () => {
    vi.mocked(client.fetchPipelineRun).mockResolvedValue(
      baseRun({
        componentList: [
          { type: "ApexClass", fullName: "MyClass" },
          { type: "CustomObject", fullName: "Account" },
        ],
        positions: [
          { type: "ApexClass", fullName: "MyClass", stage: 0, reachedAt: null },
          { type: "CustomObject", fullName: "Account", stage: 0, reachedAt: null },
        ],
      })
    );
    renderPage();
    await screen.findByText("ApexClass/MyClass");
    expect(screen.getByText("CustomObject/Account")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: /filter by component/i }), { target: { value: "myclass" } });

    expect(screen.getByText("ApexClass/MyClass")).toBeInTheDocument();
    expect(screen.queryByText("CustomObject/Account")).not.toBeInTheDocument();
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

  it("color-codes a reached stage in success color and a failed one in danger color, matching status badges elsewhere", async () => {
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
    expect(cell.querySelector(".status-label-danger")).toBeInTheDocument();
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
    // "Dev" renders twice (stepper + grid header); wait for either to appear.
    await screen.findAllByText("Dev");

    const hop0Deploy = screen.getAllByRole("button", { name: /^deploy$/i })[0];
    const hop1Deploy = screen.getAllByRole("button", { name: /^deploy$/i })[1];
    expect(hop0Deploy).not.toBeDisabled();
    expect(hop1Deploy).toBeDisabled();
  });

  it("deploys a hop and refetches the run", async () => {
    vi.mocked(client.fetchPipelineRun).mockResolvedValue(baseRun());
    vi.mocked(client.deployPipelineStep).mockResolvedValue({ deploymentId: "d1", skipped: false });
    renderPage();
    // "Dev" renders twice (stepper + grid header); wait for either to appear.
    await screen.findAllByText("Dev");

    fireEvent.click(screen.getAllByRole("button", { name: /^deploy$/i })[0]);

    await waitFor(() => expect(client.deployPipelineStep).toHaveBeenCalledWith("r1", 0, { validateOnly: false }));
    await waitFor(() => expect(client.fetchPipelineRun).toHaveBeenCalledTimes(2));
  });

  it("validates a hop without advancing anyone", async () => {
    vi.mocked(client.fetchPipelineRun).mockResolvedValue(baseRun());
    vi.mocked(client.deployPipelineStep).mockResolvedValue({ deploymentId: "d1", skipped: false });
    renderPage();
    // "Dev" renders twice (stepper + grid header); wait for either to appear.
    await screen.findAllByText("Dev");

    fireEvent.click(screen.getAllByRole("button", { name: /^validate$/i })[0]);

    await waitFor(() => expect(client.deployPipelineStep).toHaveBeenCalledWith("r1", 0, { validateOnly: true }));
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

  // The deploy endpoint answers while the hop is still deploying, so a single post-deploy refetch
  // leaves the stepper and grid stale until the user reloads the page by hand.
  it("keeps polling the run while a tagged deployment is still in progress, and stops once it finishes", async () => {
    const inProgress = baseRun({
      deployments: [
        {
          id: "d1",
          stepIndex: 0,
          status: "deploying",
          validateOnly: false,
          startedAt: "2026-01-01T00:00:00.000Z",
          finishedAt: null,
          errorDetail: null,
          items: [],
        },
      ],
    });
    const finished = baseRun({
      deployments: [
        {
          id: "d1",
          stepIndex: 0,
          status: "succeeded",
          validateOnly: false,
          startedAt: "2026-01-01T00:00:00.000Z",
          finishedAt: "2026-01-01T00:05:00.000Z",
          errorDetail: null,
          items: [{ metadataType: "ApexClass", apiName: "MyClass", status: "succeeded" }],
        },
      ],
      positions: [{ type: "ApexClass", fullName: "MyClass", stage: 1, reachedAt: "2026-01-01T00:05:00.000Z" }],
    });

    vi.useFakeTimers();
    try {
      vi.mocked(client.fetchPipelineRun)
        .mockResolvedValueOnce(baseRun())
        .mockResolvedValueOnce(inProgress)
        .mockResolvedValueOnce(inProgress)
        .mockResolvedValueOnce(finished);
      vi.mocked(client.deployPipelineStep).mockResolvedValue({ deploymentId: "d1", skipped: false });

      renderPage();
      // `findBy*`/`waitFor` can't run under fake timers (they rely on the very setTimeout fake
      // timers replace), so pending promise resolutions are flushed by hand — see
      // DeploymentDetail.test.tsx's `flush` helper for the same pattern.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(client.fetchPipelineRun).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getAllByRole("button", { name: /^deploy$/i })[0]);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      // The deploy's own refetch: the hop is now 'deploying', so a poll must be scheduled.
      expect(client.fetchPipelineRun).toHaveBeenCalledTimes(2);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(client.fetchPipelineRun).toHaveBeenCalledTimes(3);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(client.fetchPipelineRun).toHaveBeenCalledTimes(4);

      // Terminal now — no further poll should be scheduled.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000);
      });
      expect(client.fetchPipelineRun).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
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

  describe("editable run title", () => {
    it("renames the run and shows the new title", async () => {
      vi.mocked(client.fetchPipelineRun).mockResolvedValue(baseRun());
      vi.mocked(client.updatePipelineRunTitle).mockResolvedValue({ id: "r1" });
      renderPage();
      await screen.findByRole("heading", { name: "Batch 1" });

      fireEvent.click(screen.getByRole("button", { name: /rename/i }));
      const input = screen.getByRole("textbox", { name: /run title/i });
      fireEvent.change(input, { target: { value: "Renamed batch" } });
      fireEvent.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => expect(client.updatePipelineRunTitle).toHaveBeenCalledWith("r1", "Renamed batch"));
      expect(await screen.findByRole("heading", { name: "Renamed batch" })).toBeInTheDocument();
    });

    it("discards the draft on Cancel without saving", async () => {
      vi.mocked(client.fetchPipelineRun).mockResolvedValue(baseRun());
      renderPage();
      await screen.findByRole("heading", { name: "Batch 1" });

      fireEvent.click(screen.getByRole("button", { name: /rename/i }));
      fireEvent.change(screen.getByRole("textbox", { name: /run title/i }), { target: { value: "Should not save" } });
      fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

      expect(client.updatePipelineRunTitle).not.toHaveBeenCalled();
      expect(screen.getByRole("heading", { name: "Batch 1" })).toBeInTheDocument();
    });
  });

  describe("Quick Deploy (Cowboy Mode)", () => {
    it("only shows the Quick Deploy button when Cowboy Mode is on", async () => {
      vi.mocked(client.fetchPipelineRun).mockResolvedValue(baseRun());
      renderPage();
      await screen.findAllByText("Dev");
      expect(screen.queryByRole("button", { name: /quick deploy/i })).not.toBeInTheDocument();
    });

    it("shows Quick Deploy once Cowboy Mode is on", async () => {
      applyCowboyMode(true);
      vi.mocked(client.fetchPipelineRun).mockResolvedValue(baseRun());
      renderPage();
      expect(await screen.findByRole("button", { name: /quick deploy/i })).toBeInTheDocument();
    });

    it("asks for confirmation naming every environment before doing anything, via a themed modal", async () => {
      applyCowboyMode(true);
      vi.mocked(client.fetchPipelineRun).mockResolvedValue(baseRun());
      renderPage();
      await screen.findAllByText("Dev");

      fireEvent.click(screen.getByRole("button", { name: /quick deploy/i }));

      const dialog = await screen.findByRole("dialog", { name: /quick deploy/i });
      expect(dialog).toHaveTextContent("Dev → QA → Prod");
      expect(client.deployPipelineStep).not.toHaveBeenCalled();

      fireEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));
      expect(screen.queryByRole("dialog", { name: /quick deploy/i })).not.toBeInTheDocument();
      expect(client.deployPipelineStep).not.toHaveBeenCalled();
    });

    it("deploys the first hop once confirmed", async () => {
      applyCowboyMode(true);
      vi.mocked(client.fetchPipelineRun).mockResolvedValue(baseRun());
      // Never resolves within this test -- only the kickoff call is being checked, not the
      // subsequent poll-until-terminal loop.
      vi.mocked(client.deployPipelineStep).mockReturnValue(new Promise(() => {}));
      renderPage();
      await screen.findAllByText("Dev");

      fireEvent.click(screen.getByRole("button", { name: /quick deploy/i }));
      fireEvent.click(await screen.findByRole("button", { name: /continue/i }));

      await waitFor(() => expect(client.deployPipelineStep).toHaveBeenCalledWith("r1", 0, { validateOnly: false }));
    });

    it("stops and reports the failure, without advancing to the next hop, when a stage fails", async () => {
      applyCowboyMode(true);
      const pending = baseRun();
      const failed = baseRun({
        deployments: [
          {
            id: "d1",
            stepIndex: 0,
            status: "failed",
            validateOnly: false,
            startedAt: "2026-01-01T00:00:00.000Z",
            finishedAt: "2026-01-01T00:05:00.000Z",
            errorDetail: null,
            items: [],
          },
        ],
      });
      vi.mocked(client.fetchPipelineRun)
        .mockResolvedValueOnce(pending) // initial page load
        .mockResolvedValueOnce(pending) // handleQuickDeploy's own re-check before deploying stage 0
        .mockResolvedValueOnce(failed); // the poll after deployPipelineStep is called
      vi.mocked(client.deployPipelineStep).mockResolvedValue({ deploymentId: "d1", skipped: false });

      vi.useFakeTimers();
      try {
        renderPage();
        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
        });

        fireEvent.click(screen.getByRole("button", { name: /quick deploy/i }));
        fireEvent.click(screen.getByRole("button", { name: /continue/i }));
        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(client.deployPipelineStep).toHaveBeenCalledWith("r1", 0, { validateOnly: false });

        await act(async () => {
          await vi.advanceTimersByTimeAsync(2000);
        });

        expect(screen.getByRole("alert")).toHaveTextContent(/dev.*qa.*failed/i);
        expect(client.deployPipelineStep).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
