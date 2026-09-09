import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AcceptInvite } from "./AcceptInvite.js";
import * as api from "../api/client.js";

vi.mock("../api/client.js");

function renderAt(token: string) {
  return render(
    <MemoryRouter initialEntries={[`/invite/${token}`]}>
      <Routes>
        <Route path="/invite/:token" element={<AcceptInvite />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("AcceptInvite", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    Object.defineProperty(window, "location", { value: { href: "" }, writable: true });
  });

  it("shows the invited email once loaded, then accepts and redirects on submit", async () => {
    vi.mocked(api.fetchInviteInfo).mockResolvedValue({ email: "newbie@example.com" });
    vi.mocked(api.acceptInvite).mockResolvedValue({ id: "u1", organizationId: "o1", email: "newbie@example.com", name: "newbie@example.com", role: "member" });

    renderAt("tok123");
    expect(await screen.findByText(/newbie@example.com/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "a-good-password" } });
    fireEvent.click(screen.getByRole("button", { name: /set password/i }));

    await waitFor(() => expect(api.acceptInvite).toHaveBeenCalledWith("tok123", "a-good-password"));
    await waitFor(() => expect(window.location.href).toBe("/"));
  });

  it("shows an error and no form when the invite link is invalid", async () => {
    vi.mocked(api.fetchInviteInfo).mockRejectedValue(new Error("This invite link is invalid or has expired"));
    renderAt("bad-token");
    expect(await screen.findByText(/invalid or has expired/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
  });
});
