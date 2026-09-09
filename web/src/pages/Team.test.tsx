import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Team } from "./Team.js";
import * as api from "../api/client.js";

vi.mock("../api/client.js");

const MEMBERS: api.TeamMember[] = [
  { id: "u1", email: "admin@example.com", name: "Admin", role: "admin", createdAt: "2026-01-01T00:00:00.000Z", lastLoginAt: null, disabledAt: null },
  { id: "u2", email: "member@example.com", name: "Member", role: "member", createdAt: "2026-01-02T00:00:00.000Z", lastLoginAt: null, disabledAt: null },
];

describe("Team", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.fetchTeam).mockResolvedValue(MEMBERS);
  });

  it("lists every member with their role", async () => {
    render(
      <MemoryRouter>
        <Team />
      </MemoryRouter>
    );
    expect(await screen.findByText("admin@example.com")).toBeInTheDocument();
    expect(screen.getByText("member@example.com")).toBeInTheDocument();
  });

  it("invites a teammate and shows the returned link/token", async () => {
    vi.mocked(api.createTeamInvite).mockResolvedValue({ id: "i1", token: "tok-abc", expiresAt: "2026-02-01T00:00:00.000Z" });
    render(
      <MemoryRouter>
        <Team />
      </MemoryRouter>
    );
    await screen.findByText("admin@example.com");

    fireEvent.change(screen.getByLabelText(/invite email/i), { target: { value: "new@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /send invite|invite/i }));

    await waitFor(() => expect(api.createTeamInvite).toHaveBeenCalledWith({ email: "new@example.com", role: "member" }));
    expect(await screen.findByText(/tok-abc/)).toBeInTheDocument();
  });

  it("resets a member's password and shows the temporary password", async () => {
    vi.mocked(api.resetMemberPassword).mockResolvedValue({ temporaryPassword: "temp-pw-123" });
    render(
      <MemoryRouter>
        <Team />
      </MemoryRouter>
    );
    await screen.findByText("member@example.com");

    // NOTE: deviation from the brief's literal test code — see task-12-report.md for details.
    // Both rows render an identically-named "Reset password" button, so an unscoped
    // getByRole("button", { name: /reset password/i }) throws "found multiple elements". Scope the
    // query to the row containing "member@example.com" via within() so we target that member's
    // button specifically (and keep asserting resetMemberPassword is called with "u2").
    const memberRow = screen.getByText("member@example.com").closest("tr")!;
    fireEvent.click(within(memberRow).getByRole("button", { name: /reset password/i }));

    await waitFor(() => expect(api.resetMemberPassword).toHaveBeenCalledWith("u2"));
    expect(await screen.findByText(/temp-pw-123/)).toBeInTheDocument();
  });

  it("removes a member and refetches the list", async () => {
    vi.mocked(api.removeMember).mockResolvedValue(undefined);
    render(
      <MemoryRouter>
        <Team />
      </MemoryRouter>
    );
    await screen.findByText("member@example.com");

    // NOTE: deviation from the brief's literal test code — see task-12-report.md for details.
    // Both rows render an identically-named "Remove" button, so an unscoped
    // getByRole("button", { name: /remove/i }) throws "found multiple elements". Scope the query to
    // the row containing "member@example.com" via within() so we target that member's button
    // specifically (and keep asserting removeMember is called with "u2").
    const memberRow = screen.getByText("member@example.com").closest("tr")!;
    fireEvent.click(within(memberRow).getByRole("button", { name: /remove/i }));

    await waitFor(() => expect(api.removeMember).toHaveBeenCalledWith("u2"));
    expect(api.fetchTeam).toHaveBeenCalledTimes(2);
  });
});
