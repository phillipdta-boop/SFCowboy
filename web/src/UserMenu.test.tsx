import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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

describe("UserMenu", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    Object.defineProperty(window, "location", { value: { href: "" }, writable: true });
  });

  it("shows the current user's name as a closed trigger", () => {
    render(<UserMenu name="Ada" email="a@example.com" />);
    expect(screen.getByRole("button", { name: "Ada" })).toBeInTheDocument();
    expect(screen.queryByText("a@example.com")).not.toBeInTheDocument();
  });

  it("opens the dropdown on click, showing the email and a usage breakdown", async () => {
    vi.mocked(api.fetchMyUsage).mockResolvedValue({
      thisMonth: { ...EMPTY_USAGE.thisMonth, succeeded: 2 },
      allTime: { ...EMPTY_USAGE.allTime, succeeded: 5, failed: 1 },
    });
    render(<UserMenu name="Ada" email="a@example.com" />);

    fireEvent.click(screen.getByRole("button", { name: "Ada" }));

    expect(screen.getByText("a@example.com")).toBeInTheDocument();
    expect(await screen.findByText("This month")).toBeInTheDocument();
    expect(screen.getAllByText("Succeeded")).toHaveLength(2);
    expect(screen.getAllByText("2").length).toBeGreaterThan(0);
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  it("closes when clicking outside the menu", async () => {
    vi.mocked(api.fetchMyUsage).mockResolvedValue(EMPTY_USAGE);
    render(
      <div>
        <UserMenu name="Ada" email="a@example.com" />
        <button type="button">Outside</button>
      </div>
    );

    fireEvent.click(screen.getByRole("button", { name: "Ada" }));
    expect(screen.getByText("a@example.com")).toBeInTheDocument();
    await screen.findByText("This month");

    fireEvent.mouseDown(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByText("a@example.com")).not.toBeInTheDocument();
  });

  it("shows an error if the usage fetch fails, without crashing", async () => {
    vi.mocked(api.fetchMyUsage).mockRejectedValue(new Error("usage fetch failed"));
    render(<UserMenu name="Ada" email="a@example.com" />);

    fireEvent.click(screen.getByRole("button", { name: "Ada" }));

    expect(await screen.findByText("usage fetch failed")).toBeInTheDocument();
  });

  it("logs out and redirects to /login when clicked", async () => {
    vi.mocked(api.fetchMyUsage).mockResolvedValue(EMPTY_USAGE);
    vi.mocked(supabase.auth.signOut).mockResolvedValue({ error: null });
    render(<UserMenu name="Ada" email="a@example.com" />);

    fireEvent.click(screen.getByRole("button", { name: "Ada" }));
    fireEvent.click(screen.getByRole("button", { name: /log out/i }));

    await waitFor(() => expect(supabase.auth.signOut).toHaveBeenCalled());
    await waitFor(() => expect(window.location.href).toBe("/login"));
  });
});
