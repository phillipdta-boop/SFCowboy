// web/src/pages/DeploymentDetail.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import * as client from "../api/client.js";
import { DeploymentDetailPage } from "./DeploymentDetail.js";

vi.mock("../api/client.js");

// Without this, mock call counts and queued `mockResolvedValueOnce` values would leak between
// tests in this file (vitest doesn't reset mocks by default), which the new polling-sequence
// tests below depend on being exact per-test.
beforeEach(() => {
  vi.resetAllMocks();
});

function baseDeployment(overrides: Partial<client.DeploymentDetail> = {}): client.DeploymentDetail {
  return {
    id: "d1",
    source_connection_id: "s",
    target_connection_id: "t",
    status: "succeeded",
    test_level: "NoTestRun",
    validate_only: 0,
    started_at: "2026-01-01T00:00:00.000Z",
    finished_at: "2026-01-01T00:01:00.000Z",
    error_detail: null,
    is_rollback_of: null,
    components: [],
    items: [],
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
  it("shows the current status and per-component results", async () => {
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
    expect(screen.getByText(/MyClass — succeeded/)).toBeInTheDocument();
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
        .mockResolvedValueOnce(baseDeployment({ status: "pending" }))
        .mockRejectedValueOnce(new Error("network blip"))
        .mockResolvedValueOnce(baseDeployment({ status: "pending" }));

      render(
        <MemoryRouter initialEntries={["/deployments/d1"]}>
          <Routes>
            <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
          </Routes>
        </MemoryRouter>
      );

      await flush();
      expect(screen.getByText(/Status: pending/)).toBeInTheDocument();
      expect(client.fetchDeployment).toHaveBeenCalledTimes(1);

      // Second poll (2s later) fails. The deployment view must stay up, with a visible error.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(client.fetchDeployment).toHaveBeenCalledTimes(2);
      expect(screen.getByText(/Status: pending/)).toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent("network blip");

      // Polling must have kept going despite the failure: the third poll succeeds and clears
      // the transient error.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(client.fetchDeployment).toHaveBeenCalledTimes(3);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByText(/Status: pending/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops polling once a terminal status is reached", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(client.fetchDeployment)
        .mockResolvedValueOnce(baseDeployment({ status: "pending" }))
        .mockResolvedValueOnce(baseDeployment({ status: "succeeded" }));

      render(
        <MemoryRouter initialEntries={["/deployments/d1"]}>
          <Routes>
            <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
          </Routes>
        </MemoryRouter>
      );

      await flush();
      expect(screen.getByText(/Status: pending/)).toBeInTheDocument();
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
});
