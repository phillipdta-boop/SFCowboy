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
  vi.mocked(client.fetchMetadataTypes).mockResolvedValue(["ApexClass", "Flow"]);
});

async function selectSourceAndTarget() {
  fireEvent.change(await screen.findByLabelText(/^source/i), { target: { value: "src1" } });
  fireEvent.change(screen.getByLabelText(/^target/i), { target: { value: "tgt1" } });
  await screen.findByRole("combobox", { name: /metadata types/i });
}

function pickMetadataType(type: string) {
  fireEvent.focus(screen.getByRole("combobox", { name: /metadata types/i }));
  fireEvent.mouseDown(screen.getByRole("option", { name: type }));
}

describe("NewDeployment page", () => {
  it("shows the title with the source and target org once both are chosen", async () => {
    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );
    await selectSourceAndTarget();
    expect(screen.getByText(/Dev.*→.*QA/)).toBeInTheDocument();
  });

  it("fetches metadata types for the chosen source once both connections are selected", async () => {
    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );
    await selectSourceAndTarget();
    expect(client.fetchMetadataTypes).toHaveBeenCalledWith("src1");
  });

  it("loads a diff scoped to the selected metadata types and pre-selects added/modified components", async () => {
    vi.mocked(client.fetchDiff).mockResolvedValue([
      { type: "ApexClass", fullName: "MyClass", status: "added" },
      { type: "ApexClass", fullName: "Removed", status: "removed" },
    ]);
    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );
    await selectSourceAndTarget();

    pickMetadataType("ApexClass");
    fireEvent.click(screen.getByRole("button", { name: /load diff/i }));

    await waitFor(() => expect(client.fetchDiff).toHaveBeenCalledWith("src1", "tgt1", ["ApexClass"]));
    await screen.findByText("MyClass");
    const addedCheckbox = screen.getByRole("checkbox", { name: "MyClass" }) as HTMLInputElement;
    const removedCheckbox = screen.getByRole("checkbox", { name: "Removed" }) as HTMLInputElement;
    expect(addedCheckbox.checked).toBe(true);
    expect(removedCheckbox.checked).toBe(false);
  });

  it("creates a deployment with the selected components and navigates to its detail page", async () => {
    vi.mocked(client.fetchDiff).mockResolvedValue([{ type: "ApexClass", fullName: "MyClass", status: "added" }]);
    vi.mocked(client.createDeployment).mockResolvedValue({ id: "deploy-1" });

    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );
    await selectSourceAndTarget();
    pickMetadataType("ApexClass");
    fireEvent.click(screen.getByRole("button", { name: /load diff/i }));
    await screen.findByText("MyClass");

    fireEvent.click(screen.getByRole("button", { name: /^deploy$/i }));

    await waitFor(() =>
      expect(client.createDeployment).toHaveBeenCalledWith({
        sourceConnectionId: "src1",
        targetConnectionId: "tgt1",
        components: [{ type: "ApexClass", fullName: "MyClass", action: "add" }],
        testLevel: "NoTestRun",
        validateOnly: false,
      })
    );
    expect(mockNavigate).toHaveBeenCalledWith("/deployments/deploy-1");
  });

  it("shows an error message when creating the deployment fails", async () => {
    vi.mocked(client.fetchDiff).mockResolvedValue([{ type: "ApexClass", fullName: "MyClass", status: "added" }]);
    vi.mocked(client.createDeployment).mockRejectedValue(new Error("target org is unreachable"));

    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );
    await selectSourceAndTarget();
    pickMetadataType("ApexClass");
    fireEvent.click(screen.getByRole("button", { name: /load diff/i }));
    await screen.findByText("MyClass");

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
    await selectSourceAndTarget();
    pickMetadataType("ApexClass");
    fireEvent.click(screen.getByRole("button", { name: /load diff/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("source connection is invalid");
  });

  it("shows All Components and Components Selected tabs with live counts", async () => {
    vi.mocked(client.fetchDiff).mockResolvedValue([
      { type: "ApexClass", fullName: "MyClass", status: "added" },
      { type: "ApexClass", fullName: "Removed", status: "removed" },
    ]);
    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );
    await selectSourceAndTarget();
    pickMetadataType("ApexClass");
    fireEvent.click(screen.getByRole("button", { name: /load diff/i }));
    await screen.findByText("MyClass");

    expect(screen.getByRole("tab", { name: /all components \(2\)/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /components selected \(1\)/i })).toBeInTheDocument();
  });

  it("shows only selected components with a Remove action on the Components Selected tab", async () => {
    vi.mocked(client.fetchDiff).mockResolvedValue([
      { type: "ApexClass", fullName: "MyClass", status: "added" },
      { type: "ApexClass", fullName: "Removed", status: "removed" },
    ]);
    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );
    await selectSourceAndTarget();
    pickMetadataType("ApexClass");
    fireEvent.click(screen.getByRole("button", { name: /load diff/i }));
    await screen.findByText("MyClass");

    fireEvent.click(screen.getByRole("tab", { name: /components selected/i }));

    expect(screen.getByText("MyClass")).toBeInTheDocument();
    expect(screen.queryByText("Removed")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove myclass/i })).toBeInTheDocument();
  });

  it("deselects a component when removed from the Components Selected tab", async () => {
    vi.mocked(client.fetchDiff).mockResolvedValue([{ type: "ApexClass", fullName: "MyClass", status: "added" }]);
    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );
    await selectSourceAndTarget();
    pickMetadataType("ApexClass");
    fireEvent.click(screen.getByRole("button", { name: /load diff/i }));
    await screen.findByText("MyClass");

    fireEvent.click(screen.getByRole("tab", { name: /components selected/i }));
    fireEvent.click(screen.getByRole("button", { name: /remove myclass/i }));

    expect(screen.getByRole("tab", { name: /components selected \(0\)/i })).toBeInTheDocument();
  });

  it("shows an error message when loading metadata types fails", async () => {
    vi.mocked(client.fetchMetadataTypes).mockRejectedValue(new Error("could not describe org"));

    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );
    fireEvent.change(await screen.findByLabelText(/^source/i), { target: { value: "src1" } });
    fireEvent.change(screen.getByLabelText(/^target/i), { target: { value: "tgt1" } });

    expect(await screen.findByRole("alert")).toHaveTextContent("could not describe org");
  });
});
