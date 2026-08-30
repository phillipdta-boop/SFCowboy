// web/src/pages/NewPipeline.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import * as client from "../api/client.js";
import { NewPipeline } from "./NewPipeline.js";

vi.mock("../api/client.js");

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => mockNavigate };
});

beforeEach(() => {
  vi.resetAllMocks();
  mockNavigate.mockClear();
  vi.mocked(client.fetchConnections).mockResolvedValue([
    { id: "1", type: "org", nickname: "Dev", createdAt: "", lastUsedAt: null },
    { id: "2", type: "org", nickname: "QA", createdAt: "", lastUsedAt: null },
    { id: "3", type: "git", nickname: "Repo", createdAt: "", lastUsedAt: null },
  ]);
});

function renderPage() {
  return render(
    <MemoryRouter>
      <NewPipeline />
    </MemoryRouter>
  );
}

describe("NewPipeline page", () => {
  it("shows a breadcrumb back to Pipelines", async () => {
    renderPage();
    const link = await screen.findByRole("link", { name: /pipelines/i });
    expect(link).toHaveAttribute("href", "/pipelines");
  });

  it("lists every connection, unnumbered until selected", async () => {
    renderPage();
    await screen.findByLabelText("Dev");
    expect(screen.getByLabelText("QA")).toBeInTheDocument();
    expect(screen.getByLabelText("Repo")).toBeInTheDocument();
    expect(screen.queryByText("1")).not.toBeInTheDocument();
  });

  it("numbers connections by the order they're selected in, and renumbers when one is removed", async () => {
    renderPage();
    await screen.findByLabelText("Dev");

    fireEvent.click(screen.getByLabelText("QA"));
    fireEvent.click(screen.getByLabelText(/Dev/));
    fireEvent.click(screen.getByLabelText(/Repo/));

    const qaLabel = screen.getByLabelText(/QA/).closest("label")!;
    const devLabel = screen.getByLabelText(/Dev/).closest("label")!;
    const repoLabel = screen.getByLabelText(/Repo/).closest("label")!;
    expect(qaLabel).toHaveTextContent("1");
    expect(devLabel).toHaveTextContent("2");
    expect(repoLabel).toHaveTextContent("3");

    // Removing the first pick renumbers the rest rather than leaving a gap.
    fireEvent.click(screen.getByLabelText(/QA/));
    expect(devLabel).toHaveTextContent("1");
    expect(repoLabel).toHaveTextContent("2");
  });

  it("disables creation until a name is entered and at least two connections are picked", async () => {
    renderPage();
    await screen.findByLabelText("Dev");
    const createButton = screen.getByRole("button", { name: /create pipeline/i });
    expect(createButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/pipeline name/i), { target: { value: "Main" } });
    fireEvent.click(screen.getByLabelText("Dev"));
    expect(createButton).toBeDisabled();

    fireEvent.click(screen.getByLabelText("QA"));
    expect(createButton).not.toBeDisabled();
  });

  it("creates a pipeline from selected connections in order and navigates to its detail page", async () => {
    vi.mocked(client.createPipeline).mockResolvedValue({
      id: "p2",
      name: "Second",
      connectionIds: ["2", "1"],
      status: "active",
      trackComponentsIndependently: true,
    });
    renderPage();
    await screen.findByLabelText("Dev");

    fireEvent.change(screen.getByLabelText(/pipeline name/i), { target: { value: "Second" } });
    fireEvent.click(screen.getByLabelText("QA"));
    fireEvent.click(screen.getByLabelText("Dev"));
    fireEvent.click(screen.getByRole("button", { name: /create pipeline/i }));

    await waitFor(() =>
      expect(client.createPipeline).toHaveBeenCalledWith({ name: "Second", connectionIds: ["2", "1"] })
    );
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/pipelines/p2"));
  });

  it("shows an error message when creating a pipeline fails, without navigating away", async () => {
    vi.mocked(client.createPipeline).mockRejectedValue(new Error("pipeline name already exists"));
    renderPage();
    await screen.findByLabelText("Dev");

    fireEvent.change(screen.getByLabelText(/pipeline name/i), { target: { value: "Second" } });
    fireEvent.click(screen.getByLabelText("Dev"));
    fireEvent.click(screen.getByLabelText("QA"));
    fireEvent.click(screen.getByRole("button", { name: /create pipeline/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("pipeline name already exists");
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("navigates back to Pipelines when Cancel is clicked", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /^cancel$/i }));
    expect(mockNavigate).toHaveBeenCalledWith("/pipelines");
  });
});
