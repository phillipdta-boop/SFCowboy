import { randomUUID } from "node:crypto";
import bcrypt from "bcrypt";
import type { Pool } from "pg";

const BCRYPT_COST_FACTOR = 12;

export interface AuthenticatedUser {
  id: string;
  organizationId: string;
  email: string;
  name: string;
  role: "admin" | "member";
}

export interface UserRow {
  id: string;
  organization_id: string;
  email: string;
  password_hash: string;
  role: "admin" | "member";
  name: string;
  created_at: string;
  last_login_at: string | null;
  disabled_at: string | null;
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST_FACTOR);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

function toAuthenticatedUser(row: UserRow): AuthenticatedUser {
  return { id: row.id, organizationId: row.organization_id, email: row.email, name: row.name, role: row.role };
}

/**
 * Emails are lowercased at every entry point (here and in every lookup below) so "Admin@x.com"
 * and "admin@x.com" can never become two different accounts — email is the login identifier and
 * globally unique across the whole platform (not just within one organization).
 */
export async function createUser(
  db: Pool,
  input: { organizationId: string; email: string; passwordHash: string; role: "admin" | "member"; name: string }
): Promise<AuthenticatedUser> {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const email = input.email.toLowerCase();
  await db.query(
    `INSERT INTO users (id, organization_id, email, password_hash, role, name, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, input.organizationId, email, input.passwordHash, input.role, input.name, createdAt]
  );
  return { id, organizationId: input.organizationId, email, name: input.name, role: input.role };
}

export async function getUserByEmail(db: Pool, email: string): Promise<UserRow | undefined> {
  const result = await db.query<UserRow>(`SELECT * FROM users WHERE email = $1`, [email.toLowerCase()]);
  return result.rows[0];
}

export async function getUserById(db: Pool, id: string): Promise<UserRow | undefined> {
  const result = await db.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [id]);
  return result.rows[0];
}

// A fixed, valid bcrypt hash of an arbitrary string, computed once at cost factor 12 — used only
// to burn the same bcrypt.compare cost on a login attempt against an unknown or disabled account,
// so response timing can't distinguish "no such account" / "disabled" from "wrong password on a
// real account" (see the security review that flagged this — a real, measurable timing side-channel).
const DUMMY_PASSWORD_HASH = "$2b$12$uC2Aq.lnzg5jY.8v1c7R4em3Y3ZfCNMuixyRtL6uTZuqUIkIu3t1K";

/**
 * Verifies credentials and, on success, records the login and returns the user's public shape.
 * Returns undefined (never throws) for a wrong password, unknown email, or disabled user — the
 * caller (the login route) gives the same generic "invalid email or password" response in every
 * case, so a failed attempt can never reveal which part was wrong.
 *
 * On the "unknown email" / "disabled user" paths we still run a bcrypt.compare (against a fixed
 * dummy hash, result discarded) instead of returning immediately. Without it, those two cases
 * would short-circuit before ever paying bcrypt's ~80-150ms cost while a wrong-password attempt
 * against a real, enabled account would pay it — letting a caller distinguish the three cases by
 * response latency alone even though the returned value is identical in all three.
 */
export async function verifyLogin(db: Pool, email: string, password: string): Promise<AuthenticatedUser | undefined> {
  const row = await getUserByEmail(db, email);
  if (!row || row.disabled_at !== null) {
    await verifyPassword(password, DUMMY_PASSWORD_HASH);
    return undefined;
  }
  const valid = await verifyPassword(password, row.password_hash);
  if (!valid) return undefined;
  await db.query(`UPDATE users SET last_login_at = $1 WHERE id = $2`, [new Date().toISOString(), row.id]);
  return toAuthenticatedUser(row);
}

export async function updateUserPassword(db: Pool, userId: string, newPasswordHash: string): Promise<void> {
  await db.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [newPasswordHash, userId]);
}

export async function setUserDisabled(db: Pool, userId: string, disabled: boolean): Promise<void> {
  await db.query(`UPDATE users SET disabled_at = $1 WHERE id = $2`, [disabled ? new Date().toISOString() : null, userId]);
}
