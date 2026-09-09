import { randomUUID, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { withTransaction } from "../db/client.js";
import { hashPassword, type AuthenticatedUser } from "./users.js";
import { createSession } from "./sessions.js";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Exported so the route handler can match acceptInvite's own deliberate validation-error messages
// verbatim (safe to relay to an unauthenticated caller) while collapsing everything else (e.g. a
// raw users.email UNIQUE-constraint violation) into a generic response — see routes.ts.
export const MIN_PASSWORD_LENGTH = 8;

export interface InviteRow {
  id: string;
  organization_id: string;
  email: string;
  role: "admin" | "member";
  token: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
}

function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function createInvite(
  db: Pool,
  input: { organizationId: string; email: string; role: "admin" | "member"; createdByUserId: string }
): Promise<{ id: string; token: string; expiresAt: string }> {
  const id = randomUUID();
  const token = generateToken();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + INVITE_TTL_MS).toISOString();
  await db.query(
    `INSERT INTO invites (id, organization_id, email, role, token, created_by, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, input.organizationId, input.email.toLowerCase(), input.role, token, input.createdByUserId, createdAt.toISOString(), expiresAt]
  );
  return { id, token, expiresAt };
}

export async function getInviteByToken(db: Pool, token: string): Promise<InviteRow | undefined> {
  const result = await db.query<InviteRow>(`SELECT * FROM invites WHERE token = $1`, [token]);
  return result.rows[0];
}

/**
 * Validates the token (exists, unexpired, unaccepted), creates the user scoped to the invite's own
 * organization/role/email (never anything the invitee supplies — see the design spec's security
 * rationale), marks the invite accepted, and logs the new user straight in. User creation and
 * marking the invite accepted are transaction-wrapped so a failure partway through can never leave
 * an invite marked accepted with no corresponding user, or vice versa.
 */
export async function acceptInvite(db: Pool, token: string, password: string): Promise<{ user: AuthenticatedUser; sessionId: string }> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }

  const invite = await getInviteByToken(db, token);
  if (!invite) throw new Error("No invite found for this link");
  if (invite.accepted_at !== null) throw new Error("This invite has already been accepted");
  if (new Date(invite.expires_at).getTime() < Date.now()) throw new Error("This invite has expired");

  const passwordHash = await hashPassword(password);
  const userId = randomUUID();
  const createdAt = new Date().toISOString();
  const email = invite.email.toLowerCase();
  const user = await withTransaction(db, async (client) => {
    // The invite's accepted_at is claimed via a conditional UPDATE *before* the user row is
    // inserted (rather than after, in the order the original unconditional UPDATE ran). A
    // conditional UPDATE is itself atomic in Postgres: if two requests race on the same token,
    // only one can flip accepted_at from NULL, and the loser's UPDATE affects zero rows and
    // throws immediately, so it never reaches the INSERT below. Checking the invite first also
    // avoids a second, unrelated race — both requests otherwise reach INSERT INTO users with the
    // same email at the same time, and since users.email is UNIQUE, the loser would fail with a
    // raw duplicate-key error instead of the friendlier "already been accepted" message. Claiming
    // the invite first means only the winner ever attempts the insert.
    const updateResult = await client.query(`UPDATE invites SET accepted_at = $1 WHERE id = $2 AND accepted_at IS NULL`, [new Date().toISOString(), invite.id]);
    if ((updateResult.rowCount ?? 0) === 0) {
      throw new Error("This invite has already been accepted");
    }
    // Inlined rather than calling createUser(db, ...) (which is typed to accept a Pool, not this
    // transaction's PoolClient) — same query createUser itself runs. Matches the precedent set by
    // deploy.ts's attachComponentsAndQueue for calling into a shared transaction.
    await client.query(
      `INSERT INTO users (id, organization_id, email, password_hash, role, name, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, invite.organization_id, email, passwordHash, invite.role, email, createdAt]
    );
    return { id: userId, organizationId: invite.organization_id, email, name: email, role: invite.role };
  });

  const session = await createSession(db, user.id);
  return { user, sessionId: session.id };
}
