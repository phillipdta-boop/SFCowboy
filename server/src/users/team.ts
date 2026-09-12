import type { Pool } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface TeamMember {
  id: string;
  email: string;
  name: string;
  role: "admin" | "member";
  disabledAt: string | null;
}

interface AppUserRow {
  id: string;
  role: "admin" | "member";
  name: string;
  disabled_at: string | null;
}

/**
 * Joins app_users (this app's org/role data) with auth.users (Supabase's own record, which is
 * where email lives) via the admin API's listUsers -- there's no Postgres view into auth.users in
 * this design (see the spec's Data Model section), so the join happens in application code
 * instead of SQL. Fine at this scale; a team is expected to be a handful of people, not thousands.
 */
export async function listTeamMembers(db: Pool, admin: SupabaseClient, organizationId: string): Promise<TeamMember[]> {
  const appUsers = await db.query<AppUserRow>(`SELECT id, role, name, disabled_at FROM app_users WHERE organization_id = $1`, [organizationId]);
  if (appUsers.rows.length === 0) return [];

  const { data, error } = await admin.auth.admin.listUsers();
  if (error) throw error;
  const emailById = new Map(data.users.map((u) => [u.id, u.email ?? ""]));

  return appUsers.rows.map((row) => ({
    id: row.id,
    email: emailById.get(row.id) ?? "",
    name: row.name,
    role: row.role,
    disabledAt: row.disabled_at,
  }));
}

/**
 * Admin action: invites a new teammate by email. Supabase creates the auth.users row immediately
 * (unconfirmed, no password yet) and sends the actual invite email.
 *
 * Amended after task review found a real bug in this function's original code: inviteUserByEmail's
 * `data` option maps to `auth.users.user_metadata` (confirmed directly against the installed
 * @supabase/auth-js SDK's own type definition, which states this explicitly), NOT `app_metadata`
 * -- and Task 2's trigger reads exclusively `raw_app_meta_data`. inviteUserByEmail has no
 * `app_metadata` option at all. The original code silently failed to scope every invited teammate
 * into their organization: the trigger's org_id/role variables always evaluated to NULL for an
 * invited user, so no app_users row was ever created for them. Fixed with a follow-up
 * updateUserById call, which DOES accept `app_metadata` directly (confirmed against the same SDK)
 * -- this performs the UPDATE that fires Task 2's trigger via its `UPDATE OF raw_app_meta_data`
 * clause, mirroring the same insert-then-update two-step schema.sql's own comments already
 * document for how Supabase's real Admin API behaves.
 *
 * Amended after Task 15's manual smoke test found a second real bug: this call had no `redirectTo`,
 * so Supabase's invite email fell back to its dashboard-configured default Site URL instead of
 * "/accept-invite" -- clicking the link established a session (Supabase's client auto-detects the
 * token in the URL hash on any page) and dropped the invitee straight into the app, silently
 * skipping the password-setting step AcceptInvite.tsx exists to run. Login.tsx's own client-side
 * "Forgot password?" call didn't have this bug because it runs in the browser, where
 * `window.location.origin` is available -- this admin-initiated call runs server-side and has no
 * such thing, hence the new `appBaseUrl` parameter.
 */
export async function createInvite(admin: SupabaseClient, appBaseUrl: string, organizationId: string, email: string, role: "admin" | "member"): Promise<void> {
  const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
    data: { organization_id: organizationId, role },
    redirectTo: `${appBaseUrl}/accept-invite`,
  });
  if (error) throw error;
  const { error: metadataError } = await admin.auth.admin.updateUserById(data.user.id, {
    app_metadata: { organization_id: organizationId, role },
  });
  if (metadataError) throw metadataError;
}

/**
 * Admin action: triggers Supabase's own password-reset email to the given address -- the same
 * flow a user reaches themselves via "Forgot password?" on the login page, just initiated by an
 * admin on a teammate's behalf. No temporary password is ever generated or transmitted by this
 * app -- Supabase owns the whole reset flow end to end.
 *
 * Amended after Task 15's manual smoke test found the same missing-redirectTo bug described on
 * createInvite above -- without it, the reset link would land on "/" instead of "/reset-password"
 * and (since Supabase's client auto-establishes a session from the URL hash on any page) silently
 * log the teammate in on their OLD password instead of prompting for a new one.
 */
export async function sendPasswordReset(admin: SupabaseClient, appBaseUrl: string, email: string): Promise<void> {
  const { error } = await admin.auth.resetPasswordForEmail(email, { redirectTo: `${appBaseUrl}/reset-password` });
  if (error) throw error;
}

async function getMemberInOrg(db: Pool, organizationId: string, userId: string): Promise<AppUserRow> {
  const result = await db.query<AppUserRow>(`SELECT id, role, name, disabled_at FROM app_users WHERE id = $1 AND organization_id = $2`, [
    userId,
    organizationId,
  ]);
  const row = result.rows[0];
  if (!row) throw new Error(`No member with id ${userId} in this organization`);
  return row;
}

/** Admin action: soft-deletes the member (app_users.disabled_at) -- this is the load-bearing
 * enforcement point once requireSupabaseUser is applied to a route (Plan 2), since it's checked
 * on every request regardless of whether the member's Supabase JWT is still cryptographically
 * valid. Does not delete or ban the underlying Supabase auth user in this plan -- see the design
 * spec's note that this is a worthwhile but non-critical belt-and-suspenders addition, left for a
 * later pass rather than this plan. */
export async function removeMember(db: Pool, organizationId: string, userId: string): Promise<void> {
  await getMemberInOrg(db, organizationId, userId);
  await db.query(`UPDATE app_users SET disabled_at = $1 WHERE id = $2`, [new Date().toISOString(), userId]);
}
