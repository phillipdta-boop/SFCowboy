import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { hashPassword, updateUserPassword, setUserDisabled, type UserRow } from "./users.js";
import { deleteSessionsForUser } from "./sessions.js";

export interface TeamMember {
  id: string;
  email: string;
  name: string;
  role: "admin" | "member";
  createdAt: string;
  lastLoginAt: string | null;
  disabledAt: string | null;
}

function toTeamMember(row: UserRow): TeamMember {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    disabledAt: row.disabled_at,
  };
}

export async function listTeamMembers(db: Pool, organizationId: string): Promise<TeamMember[]> {
  const result = await db.query<UserRow>(`SELECT * FROM users WHERE organization_id = $1 ORDER BY created_at ASC`, [organizationId]);
  return result.rows.map(toTeamMember);
}

async function getMemberInOrg(db: Pool, organizationId: string, userId: string): Promise<UserRow> {
  const result = await db.query<UserRow>(`SELECT * FROM users WHERE id = $1 AND organization_id = $2`, [userId, organizationId]);
  const row = result.rows[0];
  if (!row) throw new Error(`No member with id ${userId} in this organization`);
  return row;
}

function generateTemporaryPassword(): string {
  // 12 URL-safe characters — comfortably above the 8-character minimum, and never contains a
  // character an admin could misread when relaying it to the teammate by hand.
  return randomBytes(9).toString("base64url");
}

/**
 * Admin action: sets a new, randomly-generated password (the admin never chooses it — see the
 * design spec) and invalidates every existing session for that user, so a compromised or
 * forgotten password stops working on the member's very next request, not just their next login.
 */
export async function resetMemberPassword(db: Pool, organizationId: string, userId: string): Promise<{ temporaryPassword: string }> {
  await getMemberInOrg(db, organizationId, userId);
  const temporaryPassword = generateTemporaryPassword();
  await updateUserPassword(db, userId, await hashPassword(temporaryPassword));
  await deleteSessionsForUser(db, userId);
  return { temporaryPassword };
}

/** Admin action: soft-deletes the member (see users.ts's disabled_at) and invalidates their sessions. */
export async function removeMember(db: Pool, organizationId: string, userId: string): Promise<void> {
  await getMemberInOrg(db, organizationId, userId);
  await setUserDisabled(db, userId, true);
  await deleteSessionsForUser(db, userId);
}
