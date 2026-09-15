import type { Pool } from "pg";
import { isAuthRetryableFetchError, type SupabaseClient } from "@supabase/supabase-js";

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
 * Fetches every user in the project via the admin API's listUsers, following its pagination
 * instead of relying on GoTrue's default page-1-of-50 -- auth.users is project-global, not scoped
 * per organization (see listTeamMembers below), so once the project has more than 50 users total
 * (across ALL organizations, not just this one), an unpaginated call would silently miss some and
 * those members would render with email: "". Loops until the SDK's own Pagination.nextPage comes
 * back null (its documented "no more pages" signal), rather than guessing from a short page --
 * see @supabase/auth-js's GoTrueAdminApi.d.ts / lib/types.d.ts for the exact shape.
 */
async function listAllUsers(admin: SupabaseClient): Promise<{ id: string; email: string }[]> {
  const users: { id: string; email: string }[] = [];
  let page = 1;
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    users.push(...data.users.map((u) => ({ id: u.id, email: u.email ?? "" })));
    const nextPage = "nextPage" in data ? data.nextPage : null;
    if (nextPage === null || nextPage === undefined) break;
    page = nextPage;
  }
  return users;
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

  const allUsers = await listAllUsers(admin);
  const emailById = new Map(allUsers.map((u) => [u.id, u.email]));

  return appUsers.rows.map((row) => ({
    id: row.id,
    email: emailById.get(row.id) ?? "",
    name: row.name,
    role: row.role,
    disabledAt: row.disabled_at,
  }));
}

/**
 * Retries a Supabase Admin API call a couple of times when it fails with an
 * AuthRetryableFetchError -- a transient network-level failure (gateway timeout, connection
 * reset) that Supabase's own SDK distinguishes from a real rejection like a hit rate limit or an
 * already-registered address (an AuthApiError, which is never retried here since retrying it
 * would just fail the same way again). Observed intermittently invoking these same admin
 * endpoints from GitHub Actions runners; presumably real users' networks hit it too, and a spurious
 * "Internal server error" on an admin trying to invite a teammate is worth a couple of retries to
 * avoid. `fn` follows the SDK's own `{ data, error }` return shape rather than throwing, so the
 * error is inspected before deciding whether to retry or let the caller's existing `if (error)
 * throw error` handle it.
 */
async function callWithRetry<R extends { error: unknown }>(fn: () => Promise<R>, attempts = 3): Promise<R> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await fn();
    if (!result.error || !isAuthRetryableFetchError(result.error) || attempt === attempts) return result;
    await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
  }
  throw new Error("unreachable"); // the loop above always returns by its last attempt
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
 *
 * Amended after final review found a third real bug: the two-step inviteUserByEmail +
 * updateUserById sequence was non-atomic with no compensating action. If updateUserById failed
 * (network blip, transient Supabase error), the invitee was left stranded: a live auth.users row
 * and invite link with no matching app_users row, and any later re-invite attempt to the same
 * address would hit an opaque `email_exists` error with no admin remedy. On that failure, this now
 * deletes the just-created auth.users row (full rollback of the invite) before rethrowing, so the
 * address is free to invite again.
 *
 * Amended to accept an optional `name`: without one, schema.sql's handle_new_auth_user() trigger
 * falls back to the invitee's email for app_users.name (COALESCE(raw_app_meta_data->>'name',
 * email)) -- fine as a fallback, but it meant every invited teammate's "Run by" attribution on a
 * deployment showed a raw email address instead of a name, once that attribution started coming
 * from req.user.name (server/src/users/requireSupabaseUser.ts) instead of a client-supplied field.
 * Only set when non-blank, so an empty string still lets the trigger's own email fallback apply
 * rather than writing app_users.name = "".
 */
export async function createInvite(admin: SupabaseClient, appBaseUrl: string, organizationId: string, email: string, role: "admin" | "member", name?: string): Promise<void> {
  const { data, error } = await callWithRetry(() =>
    admin.auth.admin.inviteUserByEmail(email, {
      redirectTo: `${appBaseUrl}/accept-invite`,
    })
  );
  if (error) throw error;
  const trimmedName = name?.trim();
  const { error: metadataError } = await callWithRetry(() =>
    admin.auth.admin.updateUserById(data.user.id, {
      app_metadata: { organization_id: organizationId, role, ...(trimmedName ? { name: trimmedName } : {}) },
    })
  );
  if (metadataError) {
    await admin.auth.admin.deleteUser(data.user.id).catch(() => {});
    throw metadataError;
  }
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
  const { error } = await callWithRetry(() => admin.auth.resetPasswordForEmail(email, { redirectTo: `${appBaseUrl}/reset-password` }));
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

/**
 * Admin action: changes a member's role. Updates app_users.role -- the value requireSupabaseUser
 * reads fresh on every request, so this takes effect immediately -- and mirrors it into the
 * Supabase auth.users app_metadata that createInvite originally set, so the member's NEXT login
 * also gets a JWT carrying the right role claim. Without the second half, a role change here would
 * work for authorization but silently disagree with what appears in the app's own session data
 * (App.tsx reads role from the JWT, not a live query) until the member happened to sign in again.
 *
 * Refuses to demote the organization's last remaining admin -- otherwise an org could strand
 * itself with no one able to reach this same route to fix it (short of a direct database edit).
 */
export async function updateMemberRole(
  db: Pool,
  admin: SupabaseClient,
  organizationId: string,
  userId: string,
  role: "admin" | "member"
): Promise<void> {
  const member = await getMemberInOrg(db, organizationId, userId);
  if (member.role === "admin" && role === "member") {
    const remainingAdmins = await db.query<{ count: string }>(
      `SELECT COUNT(*) FROM app_users WHERE organization_id = $1 AND role = 'admin' AND disabled_at IS NULL`,
      [organizationId]
    );
    if (Number(remainingAdmins.rows[0].count) <= 1) {
      throw new Error("Cannot demote the organization's last remaining admin");
    }
  }

  await db.query(`UPDATE app_users SET role = $1 WHERE id = $2`, [role, userId]);

  const { data, error } = await admin.auth.admin.getUserById(userId);
  if (error) throw error;
  const { error: metadataError } = await admin.auth.admin.updateUserById(userId, {
    app_metadata: { ...data.user.app_metadata, role },
  });
  if (metadataError) throw metadataError;
}
