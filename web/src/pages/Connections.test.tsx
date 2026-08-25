// web/src/pages/Connections.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import * as client from "../api/client.js";
import { Connections } from "./Connections.js";

vi.mock("../api/client.js");

beforeEach(() => {
  vi.mocked(client.fetchConnections).mockResolvedValue([
    { id: "1", type: "org", nickname: "Dev Sandbox", createdAt: "2026-01-01", lastUsedAt: null, orgType: "sandbox", instanceUrl: "https://x" },
  ]);
});

describe("Connections page", () => {
  it("lists existing connections", async () => {
    render(<Connections />);
    expect(await screen.findByText("Dev Sandbox")).toBeInTheDocument();
  });

  it("creates a git connection from the form", async () => {
    vi.mocked(client.createGitConnection).mockResolvedValue({
      id: "2", type: "git", nickname: "Repo", createdAt: "2026-01-01", lastUsedAt: null, remoteUrl: "https://github.com/x/y.git", defaultBranch: "main",
    });
    render(<Connections />);
    await screen.findByText("Dev Sandbox");

    fireEvent.change(screen.getByLabelText(/git nickname/i), { target: { value: "Repo" } });
    fireEvent.change(screen.getByLabelText(/remote url/i), { target: { value: "https://github.com/x/y.git" } });
    fireEvent.change(screen.getByLabelText(/branch/i), { target: { value: "main" } });
    fireEvent.change(screen.getByLabelText(/auth token/i), { target: { value: "ghp_abc" } });
    fireEvent.click(screen.getByRole("button", { name: /add git repo/i }));

    await waitFor(() => expect(client.createGitConnection).toHaveBeenCalledWith({
      nickname: "Repo", remoteUrl: "https://github.com/x/y.git", defaultBranch: "main", authToken: "ghp_abc",
    }));
  });

  it("deletes a connection", async () => {
    vi.mocked(client.deleteConnection).mockResolvedValue(undefined);
    render(<Connections />);
    await screen.findByText("Dev Sandbox");

    fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    await waitFor(() => expect(client.deleteConnection).toHaveBeenCalledWith("1"));
  });
});
