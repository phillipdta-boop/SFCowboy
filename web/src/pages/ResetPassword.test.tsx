import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ResetPassword } from "./ResetPassword.js";
import { supabase } from "../supabaseClient.js";

vi.mock("../supabaseClient.js", () => ({
  supabase: { auth: { updateUser: vi.fn() } },
}));

describe("ResetPassword", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    Object.defineProperty(window, "location", { value: { href: "" }, writable: true });
  });

  it("sets the new password and redirects to / on success", async () => {
    vi.mocked(supabase.auth.updateUser).mockResolvedValue({ data: {} as any, error: null });
    render(
      <MemoryRouter>
        <ResetPassword />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText(/new password/i), { target: { value: "a-new-password-1" } });
    fireEvent.click(screen.getByRole("button", { name: /set new password/i }));

    await waitFor(() => expect(supabase.auth.updateUser).toHaveBeenCalledWith({ password: "a-new-password-1" }));
    await waitFor(() => expect(window.location.href).toBe("/"));
  });

  it("shows an error on failure without redirecting", async () => {
    vi.mocked(supabase.auth.updateUser).mockResolvedValue({ data: {} as any, error: { message: "Password too short" } as any });
    render(
      <MemoryRouter>
        <ResetPassword />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText(/new password/i), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: /set new password/i }));

    expect(await screen.findByText("Password too short")).toBeInTheDocument();
    expect(window.location.href).toBe("");
  });
});
