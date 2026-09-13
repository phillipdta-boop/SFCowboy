import { useEffect, useState, type FormEvent } from "react";
import { fetchTeam, createTeamInvite, sendMemberPasswordReset, removeMember, type TeamMember } from "../api/client.js";

export function Team() {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    fetchTeam()
      .then(setMembers)
      .catch((err) => {
        setError((err as Error).message);
        setInfo(null);
      });
  }

  useEffect(load, []);

  async function handleInvite(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await createTeamInvite({ email: inviteEmail, role: inviteRole, name: inviteName || undefined });
      setInfo(`Invite sent to ${inviteEmail}.`);
      setInviteEmail("");
      setInviteName("");
      load();
    } catch (err) {
      setError((err as Error).message);
      setInfo(null);
    }
  }

  async function handleReset(userId: string, email: string) {
    setError(null);
    try {
      await sendMemberPasswordReset(userId);
      setInfo(`Password reset email sent to ${email}.`);
    } catch (err) {
      setError((err as Error).message);
      setInfo(null);
    }
  }

  async function handleRemove(userId: string) {
    setError(null);
    try {
      await removeMember(userId);
      load();
    } catch (err) {
      setError((err as Error).message);
      setInfo(null);
    }
  }

  return (
    <div className="team-page">
      <h1>Team</h1>
      {error && <div className="error-banner">{error}</div>}
      {info && <div className="info-banner">{info}</div>}

      <form className="invite-form" onSubmit={handleInvite}>
        <label htmlFor="invite-email">Invite email</label>
        <input id="invite-email" type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} required />
        <label htmlFor="invite-name">Name</label>
        <input id="invite-name" type="text" value={inviteName} onChange={(e) => setInviteName(e.target.value)} placeholder="Optional — shown as their name and on deployments they run" />
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
                <button type="button" onClick={() => handleReset(m.id, m.email)} disabled={!!m.disabledAt}>
                  Send password reset
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
