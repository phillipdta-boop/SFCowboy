// web/src/pages/ConnectionDetail.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import * as client from "../api/client.js";
import { ConnectionDetail } from "./ConnectionDetail.js";

vi.mock("../api/client.js");

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => mockNavigate };
});

function orgConnection(overrides: Partial<client.ConnectionSummary> = {}): client.ConnectionSummary {
  return {
    id: "c1",
    type: "org",
    nickname: "Default Org",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: null,
    instanceUrl: "https://effluenceconsultingptyltd.my.salesforce.com",
    orgType: "production",
    username: "phillip.ta@effluence.com.au",
    ...overrides,
  };
}

function gitConnection(overrides: Partial<client.ConnectionSummary> = {}): client.ConnectionSummary {
  return {
    id: "c2",
    type: "git",
    nickname: "Metadata Repo",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: null,
    remoteUrl: "https://github.com/x/y.git",
    defaultBranch: "main",
    ...overrides,
  };
}

function renderPage(id = "c1") {
  return render(
    <MemoryRouter initialEntries={[`/connections/${id}`]}>
      <Routes>
        <Route path="/connections/:id" element={<ConnectionDetail />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ConnectionDetail page", () => {
  it("shows a breadcrumb back to Connections and the connection's name as the heading", async () => {
    vi.mocked(client.fetchConnection).mockResolvedValue(orgConnection());
    renderPage();

    expect(await screen.findByRole("heading", { name: /default org/i })).toBeInTheDocument();
    const breadcrumbLink = screen.getByRole("link", { name: /connections/i });
    expect(breadcrumbLink).toHaveAttribute("href", "/connections");
  });

  it("shows Type, Name, Environment, Salesforce Login, and Instance Url for an org connection", async () => {
    vi.mocked(client.fetchConnection).mockResolvedValue(orgConnection());
    renderPage();

    await screen.findByRole("heading", { name: /default org/i });
    expect(screen.getByLabelText(/^type/i)).toHaveValue("org");
    expect(screen.getByLabelText(/^name/i)).toHaveValue("Default Org");
    expect(screen.getByLabelText(/environment/i)).toHaveValue("production");
    expect(screen.getByLabelText(/salesforce login/i)).toHaveValue("phillip.ta@effluence.com.au");
    expect(screen.getByLabelText(/instance url/i)).toHaveValue("https://effluenceconsultingptyltd.my.salesforce.com");
  });

  it("falls back to an em dash for Salesforce Login when no username was captured", async () => {
    vi.mocked(client.fetchConnection).mockResolvedValue(orgConnection({ username: null }));
    renderPage();

    await screen.findByRole("heading", { name: /default org/i });
    expect(screen.getByLabelText(/salesforce login/i)).toHaveValue("—");
  });

  it("shows Remote Url and Branch instead of Salesforce fields for a git connection, and offers no Re-authorize button", async () => {
    vi.mocked(client.fetchConnection).mockResolvedValue(gitConnection());
    renderPage("c2");

    await screen.findByRole("heading", { name: /metadata repo/i });
    expect(screen.getByLabelText(/remote url/i)).toHaveValue("https://github.com/x/y.git");
    expect(screen.getByLabelText(/branch/i)).toHaveValue("main");
    expect(screen.queryByLabelText(/salesforce login/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /re-authorize/i })).not.toBeInTheDocument();
  });

  it("surfaces an error instead of the form when the connection fails to load", async () => {
    vi.mocked(client.fetchConnection).mockRejectedValue(new Error("connection not found"));
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("connection not found");
  });

  it("flags a connection that needs re-authorization", async () => {
    vi.mocked(client.fetchConnection).mockResolvedValue(orgConnection({ lastError: "invalid_grant" }));
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent(/needs re-authorization/i);
  });

  it("saves a renamed connection and shows a confirmation", async () => {
    vi.mocked(client.fetchConnection).mockResolvedValue(orgConnection());
    vi.mocked(client.renameConnection).mockResolvedValue({ id: "c1" });
    renderPage();

    const nameInput = await screen.findByLabelText(/^name/i);
    fireEvent.change(nameInput, { target: { value: "Renamed Org" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(client.renameConnection).toHaveBeenCalledWith("c1", "Renamed Org"));
    expect(await screen.findByRole("status")).toHaveTextContent(/saved/i);
  });

  it("disables Save until the name actually changes, and disables it again once saved", async () => {
    vi.mocked(client.fetchConnection).mockResolvedValue(orgConnection());
    vi.mocked(client.renameConnection).mockResolvedValue({ id: "c1" });
    renderPage();

    const nameInput = await screen.findByLabelText(/^name/i);
    const saveButton = screen.getByRole("button", { name: /^save$/i });
    expect(saveButton).toBeDisabled();

    fireEvent.change(nameInput, { target: { value: "Renamed Org" } });
    expect(saveButton).not.toBeDisabled();

    fireEvent.click(saveButton);
    await waitFor(() => expect(client.renameConnection).toHaveBeenCalled());
    expect(saveButton).toBeDisabled();
  });

  it("shows an error when saving fails", async () => {
    vi.mocked(client.fetchConnection).mockResolvedValue(orgConnection());
    vi.mocked(client.renameConnection).mockRejectedValue(new Error("nickname already in use"));
    renderPage();

    fireEvent.change(await screen.findByLabelText(/^name/i), { target: { value: "Renamed Org" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("nickname already in use");
  });

  it("tests the connection and shows success", async () => {
    vi.mocked(client.fetchConnection).mockResolvedValue(orgConnection());
    vi.mocked(client.testConnection).mockResolvedValue({ ok: true });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /test connection/i }));

    await waitFor(() => expect(client.testConnection).toHaveBeenCalledWith("c1"));
    expect(await screen.findByRole("status")).toHaveTextContent(/working/i);
  });

  it("tests the connection and shows the failure reason", async () => {
    vi.mocked(client.fetchConnection).mockResolvedValue(orgConnection());
    vi.mocked(client.testConnection).mockResolvedValue({ ok: false, error: "invalid_grant" });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /test connection/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/invalid_grant/);
  });

  it("redirects to Salesforce when Re-authorize is clicked", async () => {
    vi.mocked(client.fetchConnection).mockResolvedValue(orgConnection());
    vi.mocked(client.startOrgAuthorization).mockResolvedValue({ authorizeUrl: "https://login.salesforce.com/authorize?x=1" });
    const location = { href: "" };
    vi.stubGlobal("location", location);

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /re-authorize/i }));

    await waitFor(() => expect(client.startOrgAuthorization).toHaveBeenCalledWith({ connectionId: "c1" }));
    await waitFor(() => expect(location.href).toBe("https://login.salesforce.com/authorize?x=1"));
  });

  it("deletes the connection after confirming, then navigates back to the list", async () => {
    vi.mocked(client.fetchConnection).mockResolvedValue(orgConnection());
    vi.mocked(client.deleteConnection).mockResolvedValue(undefined);
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /^delete$/i }));

    await waitFor(() => expect(client.deleteConnection).toHaveBeenCalledWith("c1"));
    expect(mockNavigate).toHaveBeenCalledWith("/connections");
  });

  it("does not delete when the confirmation is declined", async () => {
    vi.mocked(client.fetchConnection).mockResolvedValue(orgConnection());
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(false));
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /^delete$/i }));

    expect(client.deleteConnection).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
