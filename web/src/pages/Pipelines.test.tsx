// web/src/pages/Pipelines.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import * as client from "../api/client.js";
import { Pipelines } from "./Pipelines.js";

vi.mock("../api/client.js");

beforeEach(() => {
  vi.mocked(client.fetchConnections).mockResolvedValue([
    { id: "1", type: "org", nickname: "Dev", createdAt: "", lastUsedAt: null },
    { id: "2", type: "org", nickname: "QA", createdAt: "", lastUsedAt: null },
  ]);
  vi.mocked(client.fetchPipelines).mockResolvedValue([
    { id: "p1", name: "Main", connectionIds: ["1", "2"], status: "active" },
  ]);
});

describe("Pipelines page", () => {
  it("lists existing pipelines with resolved connection nicknames", async () => {
    render(<Pipelines />);
    expect(await screen.findByText("Main")).toBeInTheDocument();
    expect(await screen.findByText(/Dev → QA/)).toBeInTheDocument();
  });

  it("creates a pipeline from selected connections in order", async () => {
    vi.mocked(client.createPipeline).mockResolvedValue({ id: "p2", name: "Second", connectionIds: ["2", "1"], status: "active" });
    render(<Pipelines />);
    await screen.findByText("Main");

    fireEvent.change(screen.getByLabelText(/pipeline name/i), { target: { value: "Second" } });
    fireEvent.click(screen.getByLabelText("QA"));
    fireEvent.click(screen.getByLabelText("Dev"));
    fireEvent.click(screen.getByRole("button", { name: /create pipeline/i }));

    await waitFor(() =>
      expect(client.createPipeline).toHaveBeenCalledWith({ name: "Second", connectionIds: ["2", "1"] })
    );
  });

  it("shows an error message when creating a pipeline fails", async () => {
    vi.mocked(client.createPipeline).mockRejectedValue(new Error("pipeline name already exists"));
    render(<Pipelines />);
    await screen.findByText("Main");

    fireEvent.change(screen.getByLabelText(/pipeline name/i), { target: { value: "Second" } });
    fireEvent.click(screen.getByLabelText("Dev"));
    fireEvent.click(screen.getByRole("button", { name: /create pipeline/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("pipeline name already exists");
  });

  it("shows a status badge and a Close toggle button for an active pipeline", async () => {
    render(<Pipelines />);
    await screen.findByText("Main");
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /close/i })).toBeInTheDocument();
  });

  it("closes a pipeline via the toggle button", async () => {
    vi.mocked(client.updatePipelineStatus).mockResolvedValue({ id: "p1", name: "Main", connectionIds: ["1", "2"], status: "closed" });
    render(<Pipelines />);
    await screen.findByText("Main");

    fireEvent.click(screen.getByRole("button", { name: /close/i }));

    await waitFor(() => expect(client.updatePipelineStatus).toHaveBeenCalledWith("p1", "closed"));
  });

  it("shows a Reopen button for a closed pipeline", async () => {
    vi.mocked(client.fetchPipelines).mockResolvedValue([
      { id: "p1", name: "Main", connectionIds: ["1", "2"], status: "closed" },
    ]);
    render(<Pipelines />);
    await screen.findByText("Main");
    expect(screen.getByText("closed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reopen/i })).toBeInTheDocument();
  });
});
