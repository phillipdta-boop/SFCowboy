// web/src/pages/DeploymentDetail.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
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

  it("re-opens a draft with existing components by auto-restoring its type filter and diff, pre-selecting what was already picked", async () => {
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
    // show its table immediately, not force the user to redo those steps.
    expect(await screen.findByRole("button", { name: /remove apexclass/i })).toBeInTheDocument();
    await screen.findByText("Existing");
    const existingCheckbox = screen.getByRole("checkbox", { name: "Existing" }) as HTMLInputElement;
    const untouchedCheckbox = screen.getByRole("checkbox", { name: "Untouched" }) as HTMLInputElement;
    expect(existingCheckbox.checked).toBe(true);
    expect(untouchedCheckbox.checked).toBe(false);
  });

  it("shows a loading spinner while a re-opened draft's diff auto-loads", async () => {
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

    fireEvent.focus(await screen.findByRole("combobox", { name: /metadata types/i }));
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
