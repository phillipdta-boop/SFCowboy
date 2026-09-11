import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Login } from "./Login.js";
import { supabase } from "../supabaseClient.js";

vi.mock("../supabaseClient.js", () => ({
  supabase: {
    auth: {
      signInWithPassword: vi.fn(),
      resetPasswordForEmail: vi.fn(),
    },
  },
}));

describe("Login", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    Object.defineProperty(window, "location", { value: { href: "" }, writable: true });
  });

  it("submits email and password and redirects to / on success", async () => {
    vi.mocked(supabase.auth.signInWithPassword).mockResolvedValue({ data: {} as any, error: null });
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "a@example.com" } });
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: "password123" } });
    fireEvent.click(screen.getByRole("button", { name: /log in/i }));

    await waitFor(() => expect(supabase.auth.signInWithPassword).toHaveBeenCalledWith({ email: "a@example.com", password: "password123" }));
    await waitFor(() => expect(window.location.href).toBe("/"));
  });

  it("shows the server's error message on failed login", async () => {
    vi.mocked(supabase.auth.signInWithPassword).mockResolvedValue({ data: {} as any, error: { message: "Invalid login credentials" } as any });
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "a@example.com" } });
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: /log in/i }));

    expect(await screen.findByText("Invalid login credentials")).toBeInTheDocument();
  });

  it("sends a password reset email and shows a confirmation instead of the form", async () => {
    vi.mocked(supabase.auth.resetPasswordForEmail).mockResolvedValue({ data: {}, error: null } as any);
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "a@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /forgot password/i }));

    await waitFor(() => expect(supabase.auth.resetPasswordForEmail).toHaveBeenCalledWith("a@example.com", expect.objectContaining({ redirectTo: expect.stringContaining("/reset-password") })));
    expect(await screen.findByText(/check your email/i)).toBeInTheDocument();
  });
});
