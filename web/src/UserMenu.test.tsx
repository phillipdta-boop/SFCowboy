import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { UserMenu } from "./UserMenu.js";
import { supabase } from "./supabaseClient.js";

vi.mock("./supabaseClient.js", () => ({
  supabase: { auth: { signOut: vi.fn() } },
}));

describe("UserMenu", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    Object.defineProperty(window, "location", { value: { href: "" }, writable: true });
  });

  it("shows the current user's name", () => {
    render(<UserMenu name="Ada" email="a@example.com" />);
    expect(screen.getByText("Ada")).toBeInTheDocument();
  });

  it("logs out and redirects to /login when clicked", async () => {
    vi.mocked(supabase.auth.signOut).mockResolvedValue({ error: null });
    render(<UserMenu name="Ada" email="a@example.com" />);

    fireEvent.click(screen.getByRole("button", { name: /log out/i }));

    await waitFor(() => expect(supabase.auth.signOut).toHaveBeenCalled());
    await waitFor(() => expect(window.location.href).toBe("/login"));
  });
});
