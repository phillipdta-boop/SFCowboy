import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AcceptInvite } from "./AcceptInvite.js";
import { supabase } from "../supabaseClient.js";

vi.mock("../supabaseClient.js", () => ({
  supabase: {
    auth: {
      getUser: vi.fn(),
      updateUser: vi.fn(),
    },
  },
}));

describe("AcceptInvite", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    Object.defineProperty(window, "location", { value: { href: "" }, writable: true });
  });

  it("shows the invited email once loaded, then sets a password and redirects", async () => {
    vi.mocked(supabase.auth.getUser).mockResolvedValue({ data: { user: { email: "newbie@example.com" } } as any, error: null });
    vi.mocked(supabase.auth.updateUser).mockResolvedValue({ data: {} as any, error: null });

    render(
      <MemoryRouter>
        <AcceptInvite />
      </MemoryRouter>
    );
    expect(await screen.findByText(/newbie@example.com/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "a-good-password" } });
    fireEvent.click(screen.getByRole("button", { name: /set password/i }));

    await waitFor(() => expect(supabase.auth.updateUser).toHaveBeenCalledWith({ password: "a-good-password" }));
    await waitFor(() => expect(window.location.href).toBe("/"));
  });

  it("shows an error and no form when there's no pending invite session", async () => {
    vi.mocked(supabase.auth.getUser).mockResolvedValue({ data: { user: null }, error: null } as any);
    render(
      <MemoryRouter>
        <AcceptInvite />
      </MemoryRouter>
    );
    expect(await screen.findByText(/invalid or has expired/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
  });

  it("shows the same error instead of hanging on 'Loading…' forever when getUser rejects", async () => {
    // A transient network error previously had no .catch() here at all -- loadError never got
    // set, leaving the user stuck on the "Loading…" screen with no error shown and no retry option.
    vi.mocked(supabase.auth.getUser).mockRejectedValue(new Error("network error"));
    render(
      <MemoryRouter>
        <AcceptInvite />
      </MemoryRouter>
    );
    expect(await screen.findByText(/invalid or has expired/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
  });
});
