import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { UserMenu } from "./UserMenu.js";
import { supabase } from "./supabaseClient.js";
import * as api from "./api/client.js";

vi.mock("./supabaseClient.js", () => ({
  supabase: { auth: { signOut: vi.fn() } },
}));
vi.mock("./api/client.js");

const EMPTY_USAGE: api.UsageBreakdown = {
  thisMonth: { pending: 0, validating: 0, deploying: 0, succeeded: 0, failed: 0, rolled_back: 0, cancelled: 0 },
  allTime: { pending: 0, validating: 0, deploying: 0, succeeded: 0, failed: 0, rolled_back: 0, cancelled: 0 },
};

function renderMenu(props: { name: string; email: string; isAdmin?: boolean }) {
  return render(
    <MemoryRouter>
      <UserMenu name={props.name} email={props.email} isAdmin={props.isAdmin ?? false} />
    </MemoryRouter>
  );
}

describe("UserMenu", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    Object.defineProperty(window, "location", { value: { href: "" }, writable: true });
  });

  it("shows the current user's name as a closed trigger", () => {
    renderMenu({ name: "Ada", email: "a@example.com" });
    expect(screen.getByRole("button", { name: "Ada" })).toBeInTheDocument();
    expect(screen.queryByText("a@example.com")).not.toBeInTheDocument();
  });

  it("opens the dropdown on click, showing the email and a usage breakdown", async () => {
    vi.mocked(api.fetchMyUsage).mockResolvedValue({
      thisMonth: { ...EMPTY_USAGE.thisMonth, succeeded: 2 },
      allTime: { ...EMPTY_USAGE.allTime, succeeded: 5, failed: 1 },
    });
    renderMenu({ name: "Ada", email: "a@example.com" });

    fireEvent.click(screen.getByRole("button", { name: "Ada" }));

    expect(screen.getByText("a@example.com")).toBeInTheDocument();
    expect(await screen.findByText("This month")).toBeInTheDocument();
    expect(screen.getAllByText("Succeeded")).toHaveLength(2);
    expect(screen.getAllByText("2").length).toBeGreaterThan(0);
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  it("always shows a link to the full usage page, regardless of role", async () => {
    vi.mocked(api.fetchMyUsage).mockResolvedValue(EMPTY_USAGE);
    renderMenu({ name: "Ada", email: "a@example.com" });

    fireEvent.click(screen.getByRole("button", { name: "Ada" }));

    expect(await screen.findByRole("link", { name: /view full usage/i })).toHaveAttribute("href", "/usage");
  });

  it("shows a Team link for an admin", async () => {
    vi.mocked(api.fetchMyUsage).mockResolvedValue(EMPTY_USAGE);
    renderMenu({ name: "Ada", email: "a@example.com", isAdmin: true });

    fireEvent.click(screen.getByRole("button", { name: "Ada" }));

    expect(await screen.findByRole("link", { name: "Team" })).toHaveAttribute("href", "/team");
  });

  it("hides the Team link for a non-admin -- the server enforces the real access control, this is just a UX nicety", async () => {
    vi.mocked(api.fetchMyUsage).mockResolvedValue(EMPTY_USAGE);
    renderMenu({ name: "Ada", email: "a@example.com", isAdmin: false });

    fireEvent.click(screen.getByRole("button", { name: "Ada" }));
    await screen.findByText("a@example.com");

    expect(screen.queryByRole("link", { name: "Team" })).not.toBeInTheDocument();
  });

  it("closes when clicking outside the menu", async () => {
    vi.mocked(api.fetchMyUsage).mockResolvedValue(EMPTY_USAGE);
    render(
      <MemoryRouter>
        <UserMenu name="Ada" email="a@example.com" isAdmin={false} />
        <button type="button">Outside</button>
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole("button", { name: "Ada" }));
    expect(screen.getByText("a@example.com")).toBeInTheDocument();
    await screen.findByText("This month");

    fireEvent.mouseDown(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByText("a@example.com")).not.toBeInTheDocument();
  });

  it("shows an error if the usage fetch fails, without crashing", async () => {
    vi.mocked(api.fetchMyUsage).mockRejectedValue(new Error("usage fetch failed"));
    renderMenu({ name: "Ada", email: "a@example.com" });

    fireEvent.click(screen.getByRole("button", { name: "Ada" }));

    expect(await screen.findByText("usage fetch failed")).toBeInTheDocument();
  });

  it("logs out and redirects to /login when clicked", async () => {
    vi.mocked(api.fetchMyUsage).mockResolvedValue(EMPTY_USAGE);
    vi.mocked(supabase.auth.signOut).mockResolvedValue({ error: null });
    renderMenu({ name: "Ada", email: "a@example.com" });

    fireEvent.click(screen.getByRole("button", { name: "Ada" }));
    fireEvent.click(screen.getByRole("button", { name: /log out/i }));

    await waitFor(() => expect(supabase.auth.signOut).toHaveBeenCalled());
    await waitFor(() => expect(window.location.href).toBe("/login"));
  });
});
