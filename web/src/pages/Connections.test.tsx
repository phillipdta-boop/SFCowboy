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

// The page reads ?connected / ?error from the OAuth callback redirect, so it needs a router.
function renderAt(path = "/connections") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Connections />
    </MemoryRouter>
  );
}

describe("Connections page", () => {
  it("lists existing connections", async () => {
    renderAt();
    expect(await screen.findByText("Dev Sandbox")).toBeInTheDocument();
  });

  it("creates a git connection from the form", async () => {
    vi.mocked(client.createGitConnection).mockResolvedValue({
      id: "2", type: "git", nickname: "Repo", createdAt: "2026-01-01", lastUsedAt: null, remoteUrl: "https://github.com/x/y.git", defaultBranch: "main",
    });
    renderAt();
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
    renderAt();
    await screen.findByText("Dev Sandbox");

    fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    await waitFor(() => expect(client.deleteConnection).toHaveBeenCalledWith("1"));
  });

  it("shows an error message when creating a git connection fails", async () => {
    vi.mocked(client.createGitConnection).mockRejectedValue(new Error("remote url already in use"));
    renderAt();
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
    renderAt();
    expect(await screen.findByRole("alert")).toHaveTextContent("service unavailable");
  });
});

// The OAuth callback redirects back to /connections?connected=1 or ?error=... — without reading
// these the user got no feedback at all on the app's primary onboarding flow.
describe("Connections page OAuth callback feedback", () => {
  it("confirms success when the callback redirected with ?connected=1", async () => {
    renderAt("/connections?connected=1");
    expect(await screen.findByRole("status")).toHaveTextContent(/connected successfully/i);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a generic failure message when the callback redirected with ?error", async () => {
    renderAt("/connections?error=oauth_failed");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/failed to connect/i);
    expect(alert).toHaveTextContent(/server logs/i);
  });

  it("does not echo raw server error detail from the error query param", async () => {
    const sensitive = 'Request failed 400: {"error":"invalid_grant","client_secret":"s3cr3t"}';
    renderAt(`/connections?error=${encodeURIComponent(sensitive)}`);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/failed to connect/i);
    expect(alert.textContent).not.toContain("invalid_grant");
    expect(alert.textContent).not.toContain("s3cr3t");
  });

  it("shows neither message on a plain visit", async () => {
    renderAt();
    await screen.findByText("Dev Sandbox");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
