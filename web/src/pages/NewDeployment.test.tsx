// web/src/pages/NewDeployment.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import * as client from "../api/client.js";
import { NewDeployment } from "./NewDeployment.js";

vi.mock("../api/client.js");

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => mockNavigate };
});

beforeEach(() => {
  mockNavigate.mockClear();
  vi.mocked(client.fetchConnections).mockResolvedValue([
    { id: "src1", type: "org", nickname: "Dev", createdAt: "", lastUsedAt: null },
    { id: "tgt1", type: "org", nickname: "QA", createdAt: "", lastUsedAt: null },
  ]);
});

describe("NewDeployment page", () => {
  it("loads a diff and pre-selects added/modified components", async () => {
    vi.mocked(client.fetchDiff).mockResolvedValue([
      { type: "ApexClass", fullName: "New", status: "added" },
      { type: "ApexClass", fullName: "Removed", status: "removed" },
    ]);
    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );

    fireEvent.change(await screen.findByLabelText(/^source/i), { target: { value: "src1" } });
    fireEvent.change(screen.getByLabelText(/^target/i), { target: { value: "tgt1" } });
    fireEvent.click(screen.getByRole("button", { name: /load diff/i }));

    await screen.findByText(/New \(added\)/);
    const addedCheckbox = screen.getByLabelText(/New \(added\)/) as HTMLInputElement;
    const removedCheckbox = screen.getByLabelText(/Removed \(removed\)/) as HTMLInputElement;
    expect(addedCheckbox.checked).toBe(true);
    expect(removedCheckbox.checked).toBe(false);
  });

  it("creates a deployment with the selected components and navigates to its detail page", async () => {
    vi.mocked(client.fetchDiff).mockResolvedValue([{ type: "ApexClass", fullName: "New", status: "added" }]);
    vi.mocked(client.createDeployment).mockResolvedValue({ id: "deploy-1" });

    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );

    fireEvent.change(await screen.findByLabelText(/^source/i), { target: { value: "src1" } });
    fireEvent.change(screen.getByLabelText(/^target/i), { target: { value: "tgt1" } });
    fireEvent.click(screen.getByRole("button", { name: /load diff/i }));
    await screen.findByText(/New \(added\)/);

    fireEvent.click(screen.getByRole("button", { name: /^deploy$/i }));

    await waitFor(() =>
      expect(client.createDeployment).toHaveBeenCalledWith({
        sourceConnectionId: "src1",
        targetConnectionId: "tgt1",
        components: [{ type: "ApexClass", fullName: "New", action: "add" }],
        testLevel: "NoTestRun",
        validateOnly: false,
      })
    );
    expect(mockNavigate).toHaveBeenCalledWith("/deployments/deploy-1");
  });

  it("shows an error message when creating the deployment fails", async () => {
    vi.mocked(client.fetchDiff).mockResolvedValue([{ type: "ApexClass", fullName: "New", status: "added" }]);
    vi.mocked(client.createDeployment).mockRejectedValue(new Error("target org is unreachable"));

    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );

    fireEvent.change(await screen.findByLabelText(/^source/i), { target: { value: "src1" } });
    fireEvent.change(screen.getByLabelText(/^target/i), { target: { value: "tgt1" } });
    fireEvent.click(screen.getByRole("button", { name: /load diff/i }));
    await screen.findByText(/New \(added\)/);

    fireEvent.click(screen.getByRole("button", { name: /^deploy$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("target org is unreachable");
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("shows an error message when loading the diff fails", async () => {
    vi.mocked(client.fetchDiff).mockRejectedValue(new Error("source connection is invalid"));

    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );

    fireEvent.change(await screen.findByLabelText(/^source/i), { target: { value: "src1" } });
    fireEvent.change(screen.getByLabelText(/^target/i), { target: { value: "tgt1" } });
    fireEvent.click(screen.getByRole("button", { name: /load diff/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("source connection is invalid");
  });
});
