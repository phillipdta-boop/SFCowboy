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

  it("keeps the default narrow main content area on other pages", () => {
    render(
      <MemoryRouter initialEntries={["/connections"]}>
        <App />
      </MemoryRouter>
    );
    expect(document.querySelector("main")).not.toHaveClass("wide");
  });
});
