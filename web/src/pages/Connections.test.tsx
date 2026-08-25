// web/src/pages/Connections.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import * as client from "../api/client.js";
import { Connections } from "./Connections.js";

vi.mock("../api/client.js");

beforeEach(() => {
  vi.mocked(client.fetchConnections).mockResolvedValue([
    { id: "1", type: "org", nickname: "Dev Sandbox", createdAt: "2026-01-01", lastUsedAt: null, orgType: "sandbox", instanceUrl: "https://x" },
  ]);
});

function renderPage() {
  return render(
    <MemoryRouter>
      <Connections />
    </MemoryRouter>
  );
}

describe("Connections page", () => {
  it("lists existing connections", async () => {
    renderPage();
    expect(await screen.findByText("Dev Sandbox")).toBeInTheDocument();
  });

  it("connects an org from the username/password form and clears it on success", async () => {
    vi.mocked(client.bootstrapOrgConnection).mockResolvedValue({
      id: "2",
      type: "org",
      nickname: "QA Sandbox",
      createdAt: "2026-01-01",
      lastUsedAt: null,
      orgType: "sandbox",
      instanceUrl: "https://qa.my.salesforce.com",
    });
    renderPage();
    await screen.findByText("Dev Sandbox");

    fireEvent.change(screen.getByLabelText(/^nickname/i), { target: { value: "QA Sandbox" } });
    fireEvent.change(screen.getByLabelText(/^username/i), { target: { value: "admin@example.com" } });
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: "hunter2" } });
    fireEvent.change(screen.getByLabelText(/security token/i), { target: { value: "TOKEN123" } });
    fireEvent.click(screen.getByRole("button", { name: /^connect$/i }));

    await waitFor(() =>
      expect(client.bootstrapOrgConnection).toHaveBeenCalledWith({
        nickname: "QA Sandbox",
        orgType: "sandbox",
        username: "admin@example.com",
        password: "hunter2",
        securityToken: "TOKEN123",
      })
    );

    // Password fields clear on success so a completed connection doesn't linger in the form.
    await waitFor(() => expect((screen.getByLabelText(/^password/i) as HTMLInputElement).value).toBe(""));
  });

  it("shows a status message while connecting (provisioning can take up to ~2 minutes)", async () => {
    let resolveBootstrap!: (v: any) => void;
    vi.mocked(client.bootstrapOrgConnection).mockReturnValue(
      new Promise((resolve) => {
        resolveBootstrap = resolve;
      })
    );
    renderPage();
    await screen.findByText("Dev Sandbox");

    fireEvent.change(screen.getByLabelText(/^nickname/i), { target: { value: "QA" } });
    fireEvent.change(screen.getByLabelText(/^username/i), { target: { value: "u@example.com" } });
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: "p" } });
    fireEvent.click(screen.getByRole("button", { name: /^connect$/i }));

    expect(await screen.findByText(/connecting/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /connecting/i })).toBeDisabled();

    resolveBootstrap({
      id: "2", type: "org", nickname: "QA", createdAt: "", lastUsedAt: null, orgType: "sandbox", instanceUrl: "https://x",
    });
    await waitFor(() => expect(screen.queryByText(/connecting/i)).not.toBeInTheDocument());
  });

  it("shows an error message when connecting an org fails, and does not clear the form", async () => {
    vi.mocked(client.bootstrapOrgConnection).mockRejectedValue(
      new Error("Could not connect to Salesforce. Check the username, password, and security token, then try again.")
    );
    renderPage();
    await screen.findByText("Dev Sandbox");

    fireEvent.change(screen.getByLabelText(/^nickname/i), { target: { value: "QA" } });
    fireEvent.change(screen.getByLabelText(/^username/i), { target: { value: "u@example.com" } });
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: /^connect$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not connect to salesforce/i);
    expect((screen.getByLabelText(/^username/i) as HTMLInputElement).value).toBe("u@example.com");
  });

  it("creates a git connection from the form", async () => {
    vi.mocked(client.createGitConnection).mockResolvedValue({
      id: "2", type: "git", nickname: "Repo", createdAt: "2026-01-01", lastUsedAt: null, remoteUrl: "https://github.com/x/y.git", defaultBranch: "main",
    });
    renderPage();
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
    renderPage();
    await screen.findByText("Dev Sandbox");

    fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    await waitFor(() => expect(client.deleteConnection).toHaveBeenCalledWith("1"));
  });

  it("shows an error message when creating a git connection fails", async () => {
    vi.mocked(client.createGitConnection).mockRejectedValue(new Error("remote url already in use"));
    renderPage();
    await screen.findByText("Dev Sandbox");

    fireEvent.change(screen.getByLabelText(/git nickname/i), { target: { value: "Repo" } });
    fireEvent.change(screen.getByLabelText(/remote url/i), { target: { value: "https://github.com/x/y.git" } });
    fireEvent.change(screen.getByLabelText(/branch/i), { target: { value: "main" } });
    fireEvent.change(screen.getByLabelText(/auth token/i), { target: { value: "ghp_abc" } });
    fireEvent.click(screen.getByRole("button", { name: /add git repo/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("remote url already in use");
  });

  it("surfaces a failure to load the connection list", async () => {
    vi.mocked(client.fetchConnections).mockRejectedValue(new Error("service unavailable"));
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("service unavailable");
  });
});
