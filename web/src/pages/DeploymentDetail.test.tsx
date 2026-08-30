// web/src/pages/DeploymentDetail.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import * as client from "../api/client.js";
import { DeploymentDetailPage } from "./DeploymentDetail.js";

vi.mock("../api/client.js");

// Without this, mock call counts and queued `mockResolvedValueOnce` values would leak between
// tests in this file (vitest doesn't reset mocks by default), which the new polling-sequence
// tests below depend on being exact per-test.
beforeEach(() => {
  vi.resetAllMocks();
  // The page always fetches connections on mount (needed by the component editor for a pending
  // draft); default it to empty so tests that don't care about connections don't have to mock it.
  vi.mocked(client.fetchConnections).mockResolvedValue([]);
  // The editor autosaves on selection changes; default it to succeed so tests that don't care
  // about autosave don't have to mock it.
  vi.mocked(client.saveDeploymentComponents).mockResolvedValue({ id: "d1" });
  // The component editor is now shown regardless of status, so every test renders it and needs
  // this mocked; default to empty so tests that don't care about metadata types don't have to.
  vi.mocked(client.fetchMetadataTypes).mockResolvedValue([]);
});

function baseDeployment(overrides: Partial<client.DeploymentDetail> = {}): client.DeploymentDetail {
  return {
    id: "d1",
    title: null,
    source_connection_id: "s",
    target_connection_id: "t",
    status: "succeeded",
    test_level: "NoTestRun",
    validate_only: 0,
    ignore_warnings: 0,
    allow_missing_files: 0,
    auto_update_package: 0,
    started_at: "2026-01-01T00:00:00.000Z",
    finished_at: "2026-01-01T00:01:00.000Z",
    error_detail: null,
    is_rollback_of: null,
    components_deployed: null,
    components_total: null,
    tests_completed: null,
    tests_total: null,
    run_by: null,
    components: [],
    run_tests: [],
    items: [],
    pipeline_run_id: null,
    coverage_percent: null,
    coverage_details: null,
    target_connection_type: "org",
    ...overrides,
  };
}

// Flushes pending microtasks (promise resolutions from mocked fetch calls, and the resulting
// React state updates) while under `vi.useFakeTimers()`, where the usual `findByText`/`waitFor`
// polling can't run because it relies on the very `setTimeout` that fake timers replace.
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("DeploymentDetailPage", () => {
  it("shows the current status without listing individual components", async () => {
    vi.mocked(client.fetchDeployment).mockResolvedValue(
      baseDeployment({ items: [{ metadata_type: "ApexClass", api_name: "MyClass", action: "modify", status: "succeeded", error_message: null }] })
    );
    render(
      <MemoryRouter initialEntries={["/deployments/d1"]}>
        <Routes>
          <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText(/Status: succeeded/)).toBeInTheDocument();
    expect(screen.queryByText(/MyClass — succeeded/)).not.toBeInTheDocument();
  });

  it("contains the status, environments, and action buttons in a single card", async () => {
    vi.mocked(client.fetchDeployment).mockResolvedValue(baseDeployment({ status: "succeeded" }));
    vi.mocked(client.fetchConnections).mockResolvedValue([
      { id: "s", type: "org", nickname: "Dev", createdAt: "", lastUsedAt: null },
      { id: "t", type: "org", nickname: "QA", createdAt: "", lastUsedAt: null },
    ]);
    render(
      <MemoryRouter initialEntries={["/deployments/d1"]}>
        <Routes>
          <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    const statusText = await screen.findByText(/Deployment succeeded/);
    const card = statusText.closest(".deployment-summary") as HTMLElement;
    expect(card).toBeTruthy();
    expect(card.querySelector(".env-card")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: /^deploy$/i })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: /^validate$/i })).toBeInTheDocument();
  });

  it("defaults a finished deployment's status panel to collapsed, with the start time summarized in the collapsed view", async () => {
    vi.mocked(client.fetchDeployment).mockResolvedValue(
      baseDeployment({ status: "succeeded", started_at: "2026-01-01T12:00:00.000Z" })
    );
    render(
      <MemoryRouter initialEntries={["/deployments/d1"]}>
        <Routes>
          <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    const statusText = await screen.findByText(/Status: succeeded/);
    const details = statusText.closest("details") as HTMLDetailsElement;
    expect(details).toBeInTheDocument();
    expect(details.open).toBe(false);
    // The start time must be visible without expanding — it's part of the always-visible summary.
    expect(screen.getByText(new RegExp(new Date("2026-01-01T12:00:00.000Z").toLocaleString()))).toBeInTheDocument();

    fireEvent.click(screen.getByText("Deployment succeeded"));
    expect(details.open).toBe(true);
    // Collapsing must never hide the content — only its native open/closed state changes.
    expect(screen.getByText(/Status: succeeded/)).toBeInTheDocument();
  });

  it("keeps an in-progress deployment's status panel open by default", async () => {
    vi.mocked(client.fetchDeployment).mockResolvedValue(baseDeployment({ status: "deploying" }));
    render(
      <MemoryRouter initialEntries={["/deployments/d1"]}>
        <Routes>
          <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    const statusText = await screen.findByText(/Status: deploying/);
    const details = statusText.closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(true);
  });

  it("shows the source and target environments linked to this deployment", async () => {
    vi.mocked(client.fetchDeployment).mockResolvedValue(
      baseDeployment({ source_connection_id: "s", target_connection_id: "t" })
    );
    vi.mocked(client.fetchConnections).mockResolvedValue([
      { id: "s", type: "org", nickname: "DevSpare", createdAt: "", lastUsedAt: null, orgType: "production" },
      { id: "t", type: "org", nickname: "EffDevTest", createdAt: "", lastUsedAt: null, orgType: "sandbox" },
    ]);

    render(
      <MemoryRouter initialEntries={["/deployments/d1"]}>
        <Routes>
          <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText("DevSpare")).toBeInTheDocument();
    expect(screen.getByText("EffDevTest")).toBeInTheDocument();
    expect(screen.getByText("Production")).toBeInTheDocument();
    expect(screen.getByText("Sandbox")).toBeInTheDocument();
  });

  it("shows who ran the deployment when set, and omits the line when it isn't", async () => {
    vi.mocked(client.fetchDeployment).mockResolvedValue(baseDeployment({ run_by: "Phillip" }));
    render(
      <MemoryRouter initialEntries={["/deployments/d1"]}>
        <Routes>
          <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
        </Routes>
      </MemoryRouter>
    );
    expect(await screen.findByText("Run by: Phillip")).toBeInTheDocument();
  });

  it("omits the Run by line for a deployment nobody is attributed to", async () => {
    vi.mocked(client.fetchDeployment).mockResolvedValue(baseDeployment({ run_by: null }));
    render(
      <MemoryRouter initialEntries={["/deployments/d1"]}>
        <Routes>
          <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
        </Routes>
      </MemoryRouter>
    );
    await screen.findByText(/Status: succeeded/);
    expect(screen.queryByText(/^Run by:/)).not.toBeInTheDocument();
  });

  it("shows the title in the heading and offers Clone/Edit/Delete for a finished deployment", async () => {
    vi.mocked(client.fetchDeployment).mockResolvedValue(baseDeployment({ status: "succeeded", title: "Sprint 12" }));
    vi.mocked(client.cloneDeployment).mockResolvedValue({ id: "clone-1" });
    vi.mocked(client.deleteDeployment).mockResolvedValue(undefined);
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));

    render(
      <MemoryRouter initialEntries={["/deployments/d1"]}>
        <Routes>
          <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByRole("heading", { name: /deployment: sprint 12/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^clone$/i }));
    await waitFor(() => expect(client.cloneDeployment).toHaveBeenCalledWith("d1"));

    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    await waitFor(() => expect(client.deleteDeployment).toHaveBeenCalledWith("d1"));

    vi.unstubAllGlobals();
  });

  it("shows a Roll back button only when the deployment succeeded", async () => {
    vi.mocked(client.fetchDeployment).mockResolvedValue(baseDeployment({ status: "failed" }));
    render(
      <MemoryRouter initialEntries={["/deployments/d1"]}>
        <Routes>
          <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    await screen.findByText(/Status: failed/);
    expect(screen.queryByRole("button", { name: /roll back/i })).not.toBeInTheDocument();
  });

  // A validate-only run ends 'succeeded' but never touched the target — rolling it back would be
  // a REAL destructive deploy. The backend rejects it; the UI must not offer it either.
  it("hides the Roll back button for a validate-only deployment", async () => {
    vi.mocked(client.fetchDeployment).mockResolvedValue(baseDeployment({ validate_only: 1 }));
    render(
      <MemoryRouter initialEntries={["/deployments/d1"]}>
        <Routes>
          <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    await screen.findByText(/Status: succeeded/);
    expect(screen.getByText(/Validation only/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /roll back/i })).not.toBeInTheDocument();
  });

  // Rollback redeploys a metadata zip to an org; a git target has no equivalent.
  it("hides the Roll back button when the deployment targeted a git connection", async () => {
    vi.mocked(client.fetchDeployment).mockResolvedValue(baseDeployment({ target_connection_type: "git" }));
    render(
      <MemoryRouter initialEntries={["/deployments/d1"]}>
        <Routes>
          <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    await screen.findByText(/Status: succeeded/);
    expect(screen.queryByRole("button", { name: /roll back/i })).not.toBeInTheDocument();
  });

  // A validate-only run never actually deploys anything, so calling its outcome a "Deployment"
  // would be misleading — this must say Validation instead, matching the in-progress wording
  // ("Validate action is in progress …") which already makes the same distinction.
  it("labels a validate-only run's outcome as a Validation, not a Deployment", async () => {
    vi.mocked(client.fetchDeployment).mockResolvedValue(baseDeployment({ status: "succeeded", validate_only: 1 }));
    render(
      <MemoryRouter initialEntries={["/deployments/d1"]}>
        <Routes>
          <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText("Validation succeeded")).toBeInTheDocument();
    expect(screen.queryByText("Deployment succeeded")).not.toBeInTheDocument();
  });

  it("labels a validate-only run's failure as a Validation failure", async () => {
    vi.mocked(client.fetchDeployment).mockResolvedValue(baseDeployment({ status: "failed", validate_only: 1 }));
    render(
      <MemoryRouter initialEntries={["/deployments/d1"]}>
        <Routes>
          <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText("Validation failed")).toBeInTheDocument();
  });

  it("still labels a real deploy's outcome as a Deployment", async () => {
    vi.mocked(client.fetchDeployment).mockResolvedValue(baseDeployment({ status: "succeeded", validate_only: 0 }));
    render(
      <MemoryRouter initialEntries={["/deployments/d1"]}>
        <Routes>
          <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText("Deployment succeeded")).toBeInTheDocument();
  });

  it("triggers a rollback and navigates to the resulting deployment", async () => {
    vi.mocked(client.fetchDeployment).mockResolvedValue(baseDeployment());
    vi.mocked(client.rollbackDeployment).mockResolvedValue({ id: "d2" });

    render(
      <MemoryRouter initialEntries={["/deployments/d1"]}>
        <Routes>
          <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
          <Route path="/deployments/d2" element={<div>Rollback started</div>} />
        </Routes>
      </MemoryRouter>
    );

    fireEvent.click(await screen.findByRole("button", { name: /roll back/i }));
    expect(await screen.findByText("Rollback started")).toBeInTheDocument();
  });

  it("shows a visible error and keeps the deployment view when rollback fails", async () => {
    vi.mocked(client.fetchDeployment).mockResolvedValue(baseDeployment());
    vi.mocked(client.rollbackDeployment).mockRejectedValue(new Error("target org rejected the rollback"));

    render(
      <MemoryRouter initialEntries={["/deployments/d1"]}>
        <Routes>
          <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    fireEvent.click(await screen.findByRole("button", { name: /roll back/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("target org rejected the rollback");
    // The deployment view must still be visible — a failed rollback shouldn't blank the page.
    expect(screen.getByText(/Status: succeeded/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /roll back/i })).toBeInTheDocument();
  });

  it("continues polling through a transient error without hiding the deployment view", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(client.fetchDeployment)
        .mockResolvedValueOnce(baseDeployment({ status: "validating" }))
        .mockRejectedValueOnce(new Error("network blip"))
        .mockResolvedValueOnce(baseDeployment({ status: "validating" }));

      render(
        <MemoryRouter initialEntries={["/deployments/d1"]}>
          <Routes>
            <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
          </Routes>
        </MemoryRouter>
      );

      await flush();
      expect(screen.getByText(/Status: validating/)).toBeInTheDocument();
      expect(client.fetchDeployment).toHaveBeenCalledTimes(1);

      // Second poll (2s later) fails. The deployment view must stay up, with a visible error.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(client.fetchDeployment).toHaveBeenCalledTimes(2);
      expect(screen.getByText(/Status: validating/)).toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent("network blip");

      // Polling must have kept going despite the failure: the third poll succeeds and clears
      // the transient error.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(client.fetchDeployment).toHaveBeenCalledTimes(3);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByText(/Status: validating/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops polling once a terminal status is reached", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(client.fetchDeployment)
        .mockResolvedValueOnce(baseDeployment({ status: "validating" }))
        .mockResolvedValueOnce(baseDeployment({ status: "succeeded" }));

      render(
        <MemoryRouter initialEntries={["/deployments/d1"]}>
          <Routes>
            <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
          </Routes>
        </MemoryRouter>
      );

      await flush();
      expect(screen.getByText(/Status: validating/)).toBeInTheDocument();
      expect(client.fetchDeployment).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(screen.getByText(/Status: succeeded/)).toBeInTheDocument();
      expect(client.fetchDeployment).toHaveBeenCalledTimes(2);

      // No further poll should be scheduled once a terminal status is reached.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000);
      });
      expect(client.fetchDeployment).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not poll further while a deployment is a pending, unrun draft", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(client.fetchDeployment).mockResolvedValue(baseDeployment({ status: "pending" }));
      vi.mocked(client.fetchMetadataTypes).mockResolvedValue([]);

      render(
        <MemoryRouter initialEntries={["/deployments/d1"]}>
          <Routes>
            <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
          </Routes>
        </MemoryRouter>
      );

      await flush();
      expect(client.fetchDeployment).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000);
      });
      expect(client.fetchDeployment).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("DeploymentDetailPage — progress and re-run/cancel", () => {
  it("shows a components progress bar once components_total is known", async () => {
    vi.mocked(client.fetchDeployment).mockResolvedValue(
      baseDeployment({ status: "deploying", components_deployed: 1, components_total: 3 })
    );
    render(
      <MemoryRouter initialEntries={["/deployments/d1"]}>
        <Routes>
          <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByRole("progressbar", { name: "Components" })).toHaveAttribute("aria-valuenow", "1");
    expect(screen.getByText("1 / 3")).toBeInTheDocument();
  });

  it("hides progress bars until the deployment has actually reached Salesforce", async () => {
    vi.mocked(client.fetchDeployment).mockResolvedValue(baseDeployment({ status: "validating" }));
    render(
      <MemoryRouter initialEntries={["/deployments/d1"]}>
        <Routes>
          <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    await screen.findByText(/Status: validating/);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("shows the coverage percentage in success color when it meets the target's minimum", async () => {
    vi.mocked(client.fetchConnections).mockResolvedValue([
      { id: "s", type: "org", nickname: "Dev", createdAt: "", lastUsedAt: null },
      { id: "t", type: "org", nickname: "QA", createdAt: "", lastUsedAt: null, minCodeCoveragePercent: 75 },
    ]);
    vi.mocked(client.fetchDeployment).mockResolvedValue(
      baseDeployment({
        status: "succeeded",
        source_connection_id: "s",
        target_connection_id: "t",
        coverage_percent: 82.5,
        coverage_details: JSON.stringify([{ name: "MyClass", numLocations: 10, numLocationsNotCovered: 2 }]),
      })
    );
    render(
      <MemoryRouter initialEntries={["/deployments/d1"]}>
        <Routes>
          <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    const line = await screen.findByText(/Code coverage: 82.5%/);
    expect(line).toHaveClass("status-label-success");
    expect(line).toHaveTextContent("minimum 75%");
  });

  it("shows the coverage percentage in danger color when it falls below the target's minimum", async () => {
    vi.mocked(client.fetchConnections).mockResolvedValue([
      { id: "s", type: "org", nickname: "Dev", createdAt: "", lastUsedAt: null },
      { id: "t", type: "org", nickname: "QA", createdAt: "", lastUsedAt: null, minCodeCoveragePercent: 75 },
    ]);
    vi.mocked(client.fetchDeployment).mockResolvedValue(
      baseDeployment({
        status: "rolled_back",
        source_connection_id: "s",
        target_connection_id: "t",
        coverage_percent: 60,
        coverage_details: JSON.stringify([{ name: "MyClass", numLocations: 10, numLocationsNotCovered: 4 }]),
      })
    );
    render(
      <MemoryRouter initialEntries={["/deployments/d1"]}>
        <Routes>
          <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText(/Code coverage: 60.0%/)).toHaveClass("status-label-danger");
  });

  it("shows a collapsed per-class coverage breakdown when coverage details are present", async () => {
    vi.mocked(client.fetchDeployment).mockResolvedValue(
      baseDeployment({
        status: "succeeded",
        coverage_percent: 80,
        coverage_details: JSON.stringify([
          { name: "ClassA", numLocations: 10, numLocationsNotCovered: 2 },
          { name: "ClassB", numLocations: 20, numLocationsNotCovered: 0 },
        ]),
      })
    );
    render(
      <MemoryRouter initialEntries={["/deployments/d1"]}>
        <Routes>
          <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    const summary = await screen.findByText("Per-class coverage");
    expect((summary.closest("details") as HTMLDetailsElement).open).toBe(false);
    expect(screen.getByText(/ClassA: 80%/)).toBeInTheDocument();
    expect(screen.getByText(/ClassB: 100%/)).toBeInTheDocument();
  });

  it("shows neither the coverage line nor the breakdown when no tests ran", async () => {
    vi.mocked(client.fetchDeployment).mockResolvedValue(baseDeployment({ status: "succeeded", coverage_percent: null, coverage_details: null }));
    render(
      <MemoryRouter initialEntries={["/deployments/d1"]}>
        <Routes>
          <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    await screen.findByText(/Status: succeeded/);
    expect(screen.queryByText(/Code coverage/)).not.toBeInTheDocument();
    expect(screen.queryByText("Per-class coverage")).not.toBeInTheDocument();
  });

  it("keeps the component editor visible on a finished deployment's page, and Deploy re-runs it as a new row using whatever is currently selected", async () => {
    vi.mocked(client.fetchDeployment).mockResolvedValue(
      baseDeployment({ status: "succeeded", components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }] })
    );
    vi.mocked(client.fetchMetadataTypes).mockResolvedValue(["ApexClass"]);
    vi.mocked(client.fetchDiff).mockResolvedValue([
      { type: "ApexClass", fullName: "MyClass", status: "modified" },
      { type: "ApexClass", fullName: "NewClass", status: "added" },
    ]);
    vi.mocked(client.rerunDeployment).mockResolvedValue({ id: "d2" });

    render(
      <MemoryRouter initialEntries={["/deployments/d1"]}>
        <Routes>
          <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
          <Route path="/deployments/d2" element={<div>Rerun landed</div>} />
        </Routes>
      </MemoryRouter>
    );

    // The table is up immediately (types restored from the deployment's own components), with no
    // extra "reopen for editing" click required.
    await screen.findByText("MyClass");
    // The user picks the newly-added component too, from the Add Components tab, before
    // deploying again.
    fireEvent.click(screen.getByRole("tab", { name: /add components/i }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "NewClass" }));

    fireEvent.click(screen.getAllByRole("button", { name: /^deploy$/i }).at(-1)!);

    await screen.findByText("Rerun landed");
    expect(client.rerunDeployment).toHaveBeenCalledWith("d1", {
      components: [
        { type: "ApexClass", fullName: "MyClass", action: "modify" },
        { type: "ApexClass", fullName: "NewClass", action: "add" },
      ],
      testLevel: "NoTestRun",
      validateOnly: false,
      ignoreWarnings: false,
      allowMissingFiles: false,
      autoUpdatePackage: false,
      runTests: [],
    });
  });

  it("the toolbar's Validate button re-runs with validateOnly: true regardless of the checkbox", async () => {
    vi.mocked(client.fetchDeployment).mockResolvedValue(
      baseDeployment({ status: "failed", components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }] })
    );
    vi.mocked(client.fetchMetadataTypes).mockResolvedValue(["ApexClass"]);
    vi.mocked(client.fetchDiff).mockResolvedValue([{ type: "ApexClass", fullName: "MyClass", status: "modified" }]);
    vi.mocked(client.rerunDeployment).mockResolvedValue({ id: "d2" });

    render(
      <MemoryRouter initialEntries={["/deployments/d1"]}>
        <Routes>
          <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
          <Route path="/deployments/d2" element={<div>Rerun landed</div>} />
        </Routes>
      </MemoryRouter>
    );

    await screen.findByText("MyClass");
    fireEvent.click(screen.getByRole("button", { name: /^validate$/i }));

    await screen.findByText("Rerun landed");
    expect(client.rerunDeployment).toHaveBeenCalledWith("d1", expect.objectContaining({ validateOnly: true }));
  });

  it("sends the browser's stored display name as runBy when deploying", async () => {
    localStorage.setItem("sfcowboy-display-name", "Phillip");
    vi.mocked(client.fetchDeployment).mockResolvedValue(
      baseDeployment({ status: "succeeded", components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }] })
    );
    vi.mocked(client.fetchMetadataTypes).mockResolvedValue(["ApexClass"]);
    vi.mocked(client.fetchDiff).mockResolvedValue([{ type: "ApexClass", fullName: "MyClass", status: "modified" }]);
    vi.mocked(client.rerunDeployment).mockResolvedValue({ id: "d2" });

    render(
      <MemoryRouter initialEntries={["/deployments/d1"]}>
        <Routes>
          <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
          <Route path="/deployments/d2" element={<div>Rerun landed</div>} />
        </Routes>
      </MemoryRouter>
    );

    await screen.findByText("MyClass");
    fireEvent.click(screen.getAllByRole("button", { name: /^deploy$/i }).at(-1)!);

    await screen.findByText("Rerun landed");
    expect(client.rerunDeployment).toHaveBeenCalledWith("d1", expect.objectContaining({ runBy: "Phillip" }));

    localStorage.clear();
  });

  it("shows an inline error and stays on the page when re-running fails", async () => {
    vi.mocked(client.fetchDeployment).mockResolvedValue(
      baseDeployment({ status: "succeeded", components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }] })
    );
    vi.mocked(client.fetchMetadataTypes).mockResolvedValue(["ApexClass"]);
    vi.mocked(client.fetchDiff).mockResolvedValue([{ type: "ApexClass", fullName: "MyClass", status: "modified" }]);
    vi.mocked(client.rerunDeployment).mockRejectedValue(new Error("target org rejected the request"));

    render(
      <MemoryRouter initialEntries={["/deployments/d1"]}>
        <Routes>
          <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    await screen.findByText("MyClass");
    fireEvent.click(screen.getAllByRole("button", { name: /^deploy$/i }).at(-1)!);

    expect(await screen.findByRole("alert")).toHaveTextContent("target org rejected the request");
  });

  it("disables Deploy/Validate while this deployment is still in progress", async () => {
    vi.mocked(client.fetchDeployment).mockResolvedValue(
      baseDeployment({ status: "deploying", components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }] })
    );
    vi.mocked(client.fetchMetadataTypes).mockResolvedValue(["ApexClass"]);
    vi.mocked(client.fetchDiff).mockResolvedValue([{ type: "ApexClass", fullName: "MyClass", status: "modified" }]);

    render(
      <MemoryRouter initialEntries={["/deployments/d1"]}>
        <Routes>
          <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    await screen.findByText("MyClass");
    expect(screen.getByRole("button", { name: /^deploy$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^validate$/i })).toBeDisabled();
  });

  it("offers Cancel only while a deployment is in progress, and calls cancelDeployment", async () => {
    vi.mocked(client.fetchDeployment).mockResolvedValue(baseDeployment({ status: "deploying" }));
    vi.mocked(client.cancelDeployment).mockResolvedValue({ id: "d1" });

    render(
      <MemoryRouter initialEntries={["/deployments/d1"]}>
        <Routes>
          <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    fireEvent.click(await screen.findByRole("button", { name: /^cancel$/i }));
    await waitFor(() => expect(client.cancelDeployment).toHaveBeenCalledWith("d1"));
  });

  it("hides Cancel once a deployment has finished", async () => {
    vi.mocked(client.fetchDeployment).mockResolvedValue(baseDeployment({ status: "succeeded" }));
    render(
      <MemoryRouter initialEntries={["/deployments/d1"]}>
        <Routes>
          <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    await screen.findByText(/Status: succeeded/);
    expect(screen.queryByRole("button", { name: /^cancel$/i })).not.toBeInTheDocument();
  });
});

describe("DeploymentDetailPage — reopening a pending draft", () => {
  it("shows the component editor instead of the status view for a pending deployment", async () => {
    vi.mocked(client.fetchDeployment).mockResolvedValue(baseDeployment({ status: "pending", title: "Sprint 12" }));
    vi.mocked(client.fetchConnections).mockResolvedValue([
      { id: "s", type: "org", nickname: "Dev", createdAt: "", lastUsedAt: null },
      { id: "t", type: "org", nickname: "QA", createdAt: "", lastUsedAt: null },
    ]);
    vi.mocked(client.fetchMetadataTypes).mockResolvedValue(["ApexClass"]);

    render(
      <MemoryRouter initialEntries={["/deployments/d1"]}>
        <Routes>
          <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByRole("heading", { name: /deployment: sprint 12/i })).toBeInTheDocument();
    expect(screen.queryByText(/^Status:/)).not.toBeInTheDocument();
  });

  it("re-opens a draft with existing components, showing the Selected tab instantly from the draft's own saved data — no diff fetch needed", async () => {
    vi.mocked(client.fetchDeployment).mockResolvedValue(
      baseDeployment({
        status: "pending",
        components: [{ type: "ApexClass", fullName: "Existing", action: "modify" }],
      })
    );
    vi.mocked(client.fetchConnections).mockResolvedValue([
      { id: "s", type: "org", nickname: "Dev", createdAt: "", lastUsedAt: null },
      { id: "t", type: "org", nickname: "QA", createdAt: "", lastUsedAt: null },
    ]);
    vi.mocked(client.fetchMetadataTypes).mockResolvedValue(["ApexClass"]);
    vi.mocked(client.fetchDiff).mockResolvedValue([
      { type: "ApexClass", fullName: "Existing", status: "unchanged" },
      { type: "ApexClass", fullName: "Untouched", status: "modified" },
    ]);

    render(
      <MemoryRouter initialEntries={["/deployments/d1"]}>
        <Routes>
          <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    // No manual "select type + Load Diff" here — a draft that already has components should
    // show its Selected tab immediately, not force the user to redo those steps.
    expect(await screen.findByRole("button", { name: /remove existing/i })).toBeInTheDocument();
    // The diff itself is never fetched just to show this — opening the deployment shouldn't wait
    // on Salesforce to display what's already picked.
    expect(client.fetchDiff).not.toHaveBeenCalled();

    // Switching to Add Components restores the type filter this draft implies and, since a diff
    // hasn't loaded yet, lazily fetches one — the full picker then reflects the existing
    // selection once it resolves.
    fireEvent.click(screen.getByRole("tab", { name: /add components/i }));
    await waitFor(() => expect(client.fetchDiff).toHaveBeenCalledWith("s", "t", ["ApexClass"]));
    expect(await screen.findByRole("button", { name: /remove apexclass/i })).toBeInTheDocument();
    const existingCheckbox = await screen.findByRole("checkbox", { name: "Existing" });
    const untouchedCheckbox = screen.getByRole("checkbox", { name: "Untouched" }) as HTMLInputElement;
    expect((existingCheckbox as HTMLInputElement).checked).toBe(true);
    expect(untouchedCheckbox.checked).toBe(false);
  });

  it("shows a loading spinner when switching to Add Components triggers its lazy diff load", async () => {
    vi.mocked(client.fetchDeployment).mockResolvedValue(
      baseDeployment({
        status: "pending",
        components: [{ type: "ApexClass", fullName: "Existing", action: "modify" }],
      })
    );
    vi.mocked(client.fetchConnections).mockResolvedValue([
      { id: "s", type: "org", nickname: "Dev", createdAt: "", lastUsedAt: null },
      { id: "t", type: "org", nickname: "QA", createdAt: "", lastUsedAt: null },
    ]);
    vi.mocked(client.fetchMetadataTypes).mockResolvedValue(["ApexClass"]);
    let resolveDiff!: (items: unknown[]) => void;
    vi.mocked(client.fetchDiff).mockReturnValue(
      new Promise((resolve) => {
        resolveDiff = resolve as (items: unknown[]) => void;
      }) as ReturnType<typeof client.fetchDiff>
    );

    render(
      <MemoryRouter initialEntries={["/deployments/d1"]}>
        <Routes>
          <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    // The Selected tab is up immediately — no spinner, since it never touches the diff.
    expect(await screen.findByRole("button", { name: /remove existing/i })).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /add components/i }));
    expect(await screen.findByRole("status")).toBeInTheDocument();

    resolveDiff([{ type: "ApexClass", fullName: "Existing", status: "unchanged" }]);

    await screen.findByText("Existing");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("switches to the status view and resumes polling once a pending draft is deployed", async () => {
    vi.mocked(client.fetchDeployment)
      .mockResolvedValueOnce(baseDeployment({ status: "pending" }))
      .mockResolvedValueOnce(baseDeployment({ status: "validating" }));
    vi.mocked(client.fetchConnections).mockResolvedValue([
      { id: "s", type: "org", nickname: "Dev", createdAt: "", lastUsedAt: null },
      { id: "t", type: "org", nickname: "QA", createdAt: "", lastUsedAt: null },
    ]);
    vi.mocked(client.fetchMetadataTypes).mockResolvedValue(["ApexClass"]);
    vi.mocked(client.fetchDiff).mockResolvedValue([{ type: "ApexClass", fullName: "MyClass", status: "added" }]);
    vi.mocked(client.runDeployment).mockResolvedValue({ id: "d1" });

    render(
      <MemoryRouter initialEntries={["/deployments/d1"]}>
        <Routes>
          <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    fireEvent.click(await screen.findByRole("tab", { name: /add components/i }));
    fireEvent.focus(screen.getByRole("combobox", { name: /metadata types/i }));
    fireEvent.mouseDown(screen.getByRole("option", { name: "ApexClass" }));
    fireEvent.click(screen.getByRole("button", { name: /load diff/i }));
    await screen.findByText("MyClass");

    // Two "Deploy" buttons exist now (a toolbar copy at the top and the original below the
    // table) — both trigger the same action; this exercises the original bottom one.
    fireEvent.click(screen.getAllByRole("button", { name: /^deploy$/i }).at(-1)!);

    expect(await screen.findByText(/Status: validating/)).toBeInTheDocument();
    expect(client.fetchDeployment).toHaveBeenCalledTimes(2);
  });
});
