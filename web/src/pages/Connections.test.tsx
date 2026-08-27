// web/src/pages/Connections.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPage(initialEntry = "/connections") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Connections />
    </MemoryRouter>
  );
}

describe("Connections page", () => {
  it("lists existing connections", async () => {
    renderPage();
    expect(await screen.findByText("Dev Sandbox")).toBeInTheDocument();
  });

  it("splits connections into a Connected Orgs list and a Connected Git Repos list", async () => {
    vi.mocked(client.fetchConnections).mockResolvedValue([
      { id: "1", type: "org", nickname: "Dev Sandbox", createdAt: "2026-01-01", lastUsedAt: null, orgType: "sandbox", instanceUrl: "https://x" },
      { id: "2", type: "git", nickname: "Repo", createdAt: "2026-01-01", lastUsedAt: null, remoteUrl: "https://github.com/x/y.git", defaultBranch: "main" },
    ]);
    renderPage();
    await screen.findByText("Dev Sandbox");

    const orgsHeading = screen.getByRole("heading", { name: /connected orgs/i });
    const gitHeading = screen.getByRole("heading", { name: /connected git repos/i });
    expect(orgsHeading).toBeInTheDocument();
    expect(gitHeading).toBeInTheDocument();

    expect(orgsHeading.compareDocumentPosition(screen.getByText("Dev Sandbox")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(gitHeading.compareDocumentPosition(screen.getByText("Repo")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("starts authorization and redirects the browser straight to Salesforce", async () => {
    vi.mocked(client.startOrgAuthorization).mockResolvedValue({
      authorizeUrl: "https://login.salesforce.com/services/oauth2/authorize?client_id=fake&state=abc",
    });
    const location = { href: "" };
    vi.stubGlobal("location", location);

    renderPage();
    await screen.findByText("Dev Sandbox");

    fireEvent.change(screen.getByLabelText(/^nickname/i), { target: { value: "Prod" } });
    fireEvent.change(screen.getByLabelText(/org type/i), { target: { value: "production" } });
    fireEvent.click(screen.getByRole("button", { name: /login with salesforce/i }));

    await waitFor(() =>
      expect(client.startOrgAuthorization).toHaveBeenCalledWith({ nickname: "Prod", orgType: "production" })
    );
    await waitFor(() =>
      expect(location.href).toBe("https://login.salesforce.com/services/oauth2/authorize?client_id=fake&state=abc")
    );
  });

  it("shows an error message when starting authorization fails", async () => {
    vi.mocked(client.startOrgAuthorization).mockRejectedValue(new Error("nickname is required"));
    renderPage();
    await screen.findByText("Dev Sandbox");

    fireEvent.change(screen.getByLabelText(/^nickname/i), { target: { value: "Prod" } });
    fireEvent.click(screen.getByRole("button", { name: /login with salesforce/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("nickname is required");
  });

  it("shows a success message and refreshes the list after returning from a completed authorization", async () => {
    renderPage("/connections?connected=1");
    expect(await screen.findByRole("status")).toHaveTextContent(/connected/i);
    expect(client.fetchConnections).toHaveBeenCalled();
  });

  it("does not offer to reconnect a healthy org connection", async () => {
    renderPage();
    await screen.findByText("Dev Sandbox");
    expect(screen.queryByRole("button", { name: /reconnect/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/needs re-authorization/i)).not.toBeInTheDocument();
  });

  it("flags an org connection whose token refresh has failed and offers to reconnect it", async () => {
    vi.mocked(client.fetchConnections).mockResolvedValue([
      {
        id: "1", type: "org", nickname: "Dev Sandbox", createdAt: "2026-01-01", lastUsedAt: null,
        orgType: "sandbox", instanceUrl: "https://x", lastError: "invalid_grant: expired access/refresh token",
      },
    ]);
    renderPage();
    await screen.findByText("Dev Sandbox");

    expect(screen.getByText(/needs re-authorization/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reconnect/i })).toBeInTheDocument();
  });

  it("re-authorizes an expired org connection and redirects the browser to Salesforce", async () => {
    vi.mocked(client.fetchConnections).mockResolvedValue([
      {
        id: "1", type: "org", nickname: "Dev Sandbox", createdAt: "2026-01-01", lastUsedAt: null,
        orgType: "sandbox", instanceUrl: "https://x", lastError: "invalid_grant",
      },
    ]);
    vi.mocked(client.startOrgAuthorization).mockResolvedValue({
      authorizeUrl: "https://test.salesforce.com/services/oauth2/authorize?client_id=fake&state=xyz",
    });
    const location = { href: "" };
    vi.stubGlobal("location", location);

    renderPage();
    await screen.findByText("Dev Sandbox");

    fireEvent.click(screen.getByRole("button", { name: /reconnect/i }));

    await waitFor(() => expect(client.startOrgAuthorization).toHaveBeenCalledWith({ connectionId: "1" }));
    await waitFor(() =>
      expect(location.href).toBe("https://test.salesforce.com/services/oauth2/authorize?client_id=fake&state=xyz")
    );
  });

  it("shows an error message when starting re-authorization fails", async () => {
    vi.mocked(client.fetchConnections).mockResolvedValue([
      {
        id: "1", type: "org", nickname: "Dev Sandbox", createdAt: "2026-01-01", lastUsedAt: null,
        orgType: "sandbox", instanceUrl: "https://x", lastError: "invalid_grant",
      },
    ]);
    vi.mocked(client.startOrgAuthorization).mockRejectedValue(new Error("org connection not found"));
    renderPage();
    await screen.findByText("Dev Sandbox");

    fireEvent.click(screen.getByRole("button", { name: /reconnect/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("org connection not found");
  });

  it("shows a success message and refreshes the list after returning from a completed re-authorization", async () => {
    renderPage("/connections?reconnected=1");
    expect(await screen.findByRole("status")).toHaveTextContent(/reconnected/i);
    expect(client.fetchConnections).toHaveBeenCalled();
  });

  it("shows an error message after returning from a failed authorization", async () => {
    renderPage("/connections?error=" + encodeURIComponent("Could not connect to Salesforce. Please try again."));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not connect to Salesforce. Please try again.");
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
