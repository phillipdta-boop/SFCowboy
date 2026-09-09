import { useEffect, useState, type FormEvent } from "react";
import { fetchTeam, createTeamInvite, resetMemberPassword, removeMember, type TeamMember } from "../api/client.js";

export function Team() {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [temporaryPassword, setTemporaryPassword] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    fetchTeam()
      .then(setMembers)
      .catch((err) => setError((err as Error).message));
  }

  useEffect(load, []);

  async function handleInvite(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const invite = await createTeamInvite({ email: inviteEmail, role: inviteRole });
      setInviteLink(`${window.location.origin}/invite/${invite.token}`);
      setInviteEmail("");
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleReset(userId: string) {
    setError(null);
    try {
      const result = await resetMemberPassword(userId);
      setTemporaryPassword(result.temporaryPassword);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleRemove(userId: string) {
    setError(null);
    try {
      await removeMember(userId);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="team-page">
      <h1>Team</h1>
      {error && <div className="error-banner">{error}</div>}
      {inviteLink && (
        <div className="info-banner">
          Share this link with the invitee: <code>{inviteLink}</code>
        </div>
      )}
      {temporaryPassword && (
        <div className="info-banner">
          Temporary password (shown once — relay it to the teammate now): <code>{temporaryPassword}</code>
        </div>
      )}

      <form className="invite-form" onSubmit={handleInvite}>
        <label htmlFor="invite-email">Invite email</label>
        <input id="invite-email" type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} required />
        <select aria-label="Role" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as "admin" | "member")}>
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
        <button type="submit">Send invite</button>
      </form>

      <table>
        <thead>
          <tr>
            <th>Email</th>
            <th>Name</th>
            <th>Role</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.id}>
              <td>{m.email}</td>
              <td>{m.name}</td>
              <td>{m.role}</td>
              <td>{m.disabledAt ? "Removed" : "Active"}</td>
              <td>
                <button type="button" onClick={() => handleReset(m.id)} disabled={!!m.disabledAt}>
                  Reset password
                </button>
                <button type="button" onClick={() => handleRemove(m.id)} disabled={!!m.disabledAt}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
