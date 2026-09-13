import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Team } from "./Team.js";
import * as api from "../api/client.js";

vi.mock("../api/client.js");

const MEMBERS: api.TeamMember[] = [
  { id: "u1", email: "admin@example.com", name: "Admin", role: "admin", disabledAt: null },
  { id: "u2", email: "member@example.com", name: "Member", role: "member", disabledAt: null },
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

  it("invites a teammate and shows a confirmation, not a link", async () => {
    vi.mocked(api.createTeamInvite).mockResolvedValue(undefined);
    render(
      <MemoryRouter>
        <Team />
      </MemoryRouter>
    );
    await screen.findByText("admin@example.com");

    fireEvent.change(screen.getByLabelText(/invite email/i), { target: { value: "new@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /send invite/i }));

    await waitFor(() => expect(api.createTeamInvite).toHaveBeenCalledWith({ email: "new@example.com", role: "member", name: undefined }));
    expect(await screen.findByText(/invite sent to new@example.com/i)).toBeInTheDocument();
  });

  it("includes the given name when inviting a teammate", async () => {
    vi.mocked(api.createTeamInvite).mockResolvedValue(undefined);
    render(
      <MemoryRouter>
        <Team />
      </MemoryRouter>
    );
    await screen.findByText("admin@example.com");

    fireEvent.change(screen.getByLabelText(/invite email/i), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "Ada Lovelace" } });
    fireEvent.click(screen.getByRole("button", { name: /send invite/i }));

    await waitFor(() => expect(api.createTeamInvite).toHaveBeenCalledWith({ email: "new@example.com", role: "member", name: "Ada Lovelace" }));
  });

  it("sends a password reset email for a member", async () => {
    vi.mocked(api.sendMemberPasswordReset).mockResolvedValue(undefined);
    render(
      <MemoryRouter>
        <Team />
      </MemoryRouter>
    );
    const memberRow = (await screen.findByText("member@example.com")).closest("tr")!;

    fireEvent.click(within(memberRow).getByRole("button", { name: /send password reset/i }));

    await waitFor(() => expect(api.sendMemberPasswordReset).toHaveBeenCalledWith("u2"));
    expect(await screen.findByText(/password reset email sent/i)).toBeInTheDocument();
  });

  it("clears a prior success banner once a later action fails, instead of showing both at once", async () => {
    vi.mocked(api.createTeamInvite).mockResolvedValue(undefined);
    vi.mocked(api.sendMemberPasswordReset).mockRejectedValue(new Error("reset failed"));
    render(
      <MemoryRouter>
        <Team />
      </MemoryRouter>
    );
    await screen.findByText("admin@example.com");

    fireEvent.change(screen.getByLabelText(/invite email/i), { target: { value: "new@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /send invite/i }));
    expect(await screen.findByText(/invite sent to new@example.com/i)).toBeInTheDocument();

    const memberRow = screen.getByText("member@example.com").closest("tr")!;
    fireEvent.click(within(memberRow).getByRole("button", { name: /send password reset/i }));

    expect(await screen.findByText(/reset failed/i)).toBeInTheDocument();
    expect(screen.queryByText(/invite sent to new@example.com/i)).not.toBeInTheDocument();
  });

  it("clears a prior error banner once a later action succeeds, instead of showing both at once", async () => {
    vi.mocked(api.sendMemberPasswordReset).mockRejectedValue(new Error("reset failed"));
    vi.mocked(api.createTeamInvite).mockResolvedValue(undefined);
    render(
      <MemoryRouter>
        <Team />
      </MemoryRouter>
    );
    const memberRow = (await screen.findByText("member@example.com")).closest("tr")!;

    fireEvent.click(within(memberRow).getByRole("button", { name: /send password reset/i }));
    expect(await screen.findByText(/reset failed/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/invite email/i), { target: { value: "new@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /send invite/i }));

    expect(await screen.findByText(/invite sent to new@example.com/i)).toBeInTheDocument();
    expect(screen.queryByText(/reset failed/i)).not.toBeInTheDocument();
  });

  it("removes a member and refetches the list", async () => {
    vi.mocked(api.removeMember).mockResolvedValue(undefined);
    render(
      <MemoryRouter>
        <Team />
      </MemoryRouter>
    );
    const memberRow = (await screen.findByText("member@example.com")).closest("tr")!;

    fireEvent.click(within(memberRow).getByRole("button", { name: /remove/i }));

    await waitFor(() => expect(api.removeMember).toHaveBeenCalledWith("u2"));
    expect(api.fetchTeam).toHaveBeenCalledTimes(2);
  });
});
