// web/src/App.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import * as client from "./api/client.js";
import { supabase } from "./supabaseClient.js";
import { App } from "./App.js";

vi.mock("./api/client.js");

vi.mock("./supabaseClient.js", () => ({
  supabase: {
    auth: {
      getSession: vi.fn(),
      onAuthStateChange: vi.fn(),
    },
  },
}));

const FIXTURE_SESSION = {
  access_token: "test-access-token",
  refresh_token: "test-refresh-token",
  expires_in: 3600,
  token_type: "bearer",
  user: {
    id: "user-1",
    email: "ada@example.com",
    user_metadata: { name: "Ada Lovelace" },
    app_metadata: { role: "admin" },
  },
} as any;

beforeEach(() => {
  vi.mocked(client.fetchConnections).mockResolvedValue([]);
  // Home.tsx (rendered at the default "/" route every test here implicitly hits) fetches all
  // three via Promise.all -- fetchPipelines/fetchDeployments were previously left unmocked
  // (automock default returns undefined, not a Promise-wrapped empty array), a latent crash
  // ("deployments is not iterable") that only surfaced once a test waited long enough for the
  // effect's microtask to actually flush before RTL's cleanup unmounted the tree.
  vi.mocked(client.fetchPipelines).mockResolvedValue([]);
  vi.mocked(client.fetchDeployments).mockResolvedValue([]);
  vi.mocked(supabase.auth.getSession).mockResolvedValue({ data: { session: FIXTURE_SESSION }, error: null } as any);
  vi.mocked(supabase.auth.onAuthStateChange).mockReturnValue({
    data: { subscription: { unsubscribe: vi.fn() } },
  } as any);
});

describe("App", () => {
  it("renders navigation links for every top-level page", async () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );
    expect(await screen.findByRole("link", { name: /^home$/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /connections/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /pipelines/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^deployments$/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /history/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /team/i })).toBeInTheDocument();
  });

  it("hides the Team nav link for a member -- the server enforces the real access control, this is just a UX nicety", async () => {
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: {
        session: {
          ...FIXTURE_SESSION,
          user: { ...FIXTURE_SESSION.user, app_metadata: { role: "member" } },
        },
      },
      error: null,
    } as any);
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );
    await screen.findByRole("navigation");
    expect(screen.queryByRole("link", { name: /team/i })).not.toBeInTheDocument();
  });

  it("renders a theme toggle in the nav", async () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );
    expect(await screen.findByRole("button", { name: /(dark|light) mode/i })).toBeInTheDocument();
  });

  it("renders the user menu in the nav once the session is confirmed", async () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );
    expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /log out/i })).toBeInTheDocument();
  });

  it("widens the main content area on the New Deployment page, which needs room for a data table", async () => {
    render(
      <MemoryRouter initialEntries={["/deploy/new"]}>
        <App />
      </MemoryRouter>
    );
    await screen.findByRole("navigation");
    expect(document.querySelector("main")).toHaveClass("wide");
  });

  it("widens the main content area on a deployment detail page, which can also render the component table", async () => {
    vi.mocked(client.fetchMetadataTypes).mockResolvedValue([]);
    vi.mocked(client.fetchDeployment).mockResolvedValue({
      id: "d1", title: null, source_connection_id: "s", target_connection_id: "t", status: "pending",
      test_level: "NoTestRun", validate_only: 0, ignore_warnings: 0, allow_missing_files: 0, auto_update_package: 0, started_at: "2026-01-01T00:00:00.000Z", finished_at: null,
      error_detail: null, is_rollback_of: null, components_deployed: null, components_total: null, tests_completed: null, tests_total: null, run_by: null, components: [], run_tests: [], items: [], pipeline_run_id: null, coverage_percent: null, coverage_details: null, source_branch: null, target_branch: null, static_analysis_findings: null, scheduled_at: null, package_path: null, target_connection_type: "org",
    });
    render(
      <MemoryRouter initialEntries={["/deployments/d1"]}>
        <App />
      </MemoryRouter>
    );
    await screen.findByRole("navigation");
    expect(document.querySelector("main")).toHaveClass("wide");
  });

  it("keeps the default narrow main content area on other pages", async () => {
    render(
      <MemoryRouter initialEntries={["/connections"]}>
        <App />
      </MemoryRouter>
    );
    await screen.findByRole("navigation");
    expect(document.querySelector("main")).not.toHaveClass("wide");
  });

  it("redirects to /login when there is no active session", async () => {
    vi.mocked(supabase.auth.getSession).mockResolvedValue({ data: { session: null }, error: null } as any);
    Object.defineProperty(window, "location", { value: { href: "" }, writable: true });
    render(
      <MemoryRouter initialEntries={["/connections"]}>
        <App />
      </MemoryRouter>
    );
    await waitFor(() => expect(window.location.href).toBe("/login"));
  });

  it("redirects to /login instead of hanging on 'Loading…' forever when getSession rejects", async () => {
    // A transient network error previously had no .catch() here at all -- checkedAuth/session
    // never got set, leaving the user stuck on the "Loading…" screen with no way out.
    vi.mocked(supabase.auth.getSession).mockRejectedValue(new Error("network error"));
    Object.defineProperty(window, "location", { value: { href: "" }, writable: true });
    render(
      <MemoryRouter initialEntries={["/connections"]}>
        <App />
      </MemoryRouter>
    );
    await waitFor(() => expect(window.location.href).toBe("/login"));
  });
});
