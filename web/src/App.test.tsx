// web/src/App.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import * as client from "./api/client.js";
import { App } from "./App.js";

vi.mock("./api/client.js");

beforeEach(() => {
  vi.mocked(client.fetchConnections).mockResolvedValue([]);
});

describe("App", () => {
  it("renders navigation links for every top-level page", () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );
    expect(screen.getByRole("link", { name: /^home$/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /connections/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /pipelines/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^deployments$/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /history/i })).toBeInTheDocument();
  });

  it("renders a theme toggle in the nav", () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );
    expect(screen.getByRole("button", { name: /(dark|light) mode/i })).toBeInTheDocument();
  });

  it("widens the main content area on the New Deployment page, which needs room for a data table", () => {
    render(
      <MemoryRouter initialEntries={["/deploy/new"]}>
        <App />
      </MemoryRouter>
    );
    expect(document.querySelector("main")).toHaveClass("wide");
  });

  it("widens the main content area on a deployment detail page, which can also render the component table", () => {
    vi.mocked(client.fetchMetadataTypes).mockResolvedValue([]);
    vi.mocked(client.fetchDeployment).mockResolvedValue({
      id: "d1", title: null, source_connection_id: "s", target_connection_id: "t", status: "pending",
      test_level: "NoTestRun", validate_only: 0, started_at: "2026-01-01T00:00:00.000Z", finished_at: null,
      error_detail: null, is_rollback_of: null, components: [], items: [], target_connection_type: "org",
    });
    render(
      <MemoryRouter initialEntries={["/deployments/d1"]}>
        <App />
      </MemoryRouter>
    );
    expect(document.querySelector("main")).toHaveClass("wide");
  });

  it("keeps the default narrow main content area on other pages", () => {
    render(
      <MemoryRouter initialEntries={["/connections"]}>
        <App />
      </MemoryRouter>
    );
    expect(document.querySelector("main")).not.toHaveClass("wide");
  });
});
