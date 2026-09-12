import type { Pool } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Config } from "../config.js";

const DEFAULT_ORGANIZATION_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Runs once per environment, the first time the app boots against a database with no admin user
 * yet: creates one admin Supabase user in the well-known default organization (already guaranteed
 * to exist by schema.sql/runMigrations -- see Task 2 -- so this function only needs to create the
 * user, not the organization). Idempotent -- a no-op on every later boot once app_users is
 * non-empty, called from index.ts right after runMigrations.
 *
 * Passing organization_id/role as app_metadata on createUser means Task 2's trigger creates the
 * matching app_users row automatically -- the same mechanism createInvite (team.ts) uses, so
 * there's exactly one code path in this codebase that ever inserts into app_users.
 *
 * organizationId defaults to the well-known default organization (production behavior, unchanged)
 * but is overridable so tests can scope the emptiness check to their own throwaway organization
 * instead of the shared project's default org, which in practice now permanently has real rows in
 * it (smoke-test data, invited teammates) that would otherwise make the check non-vacuous forever.
 */
export async function bootstrapIfNeeded(
  db: Pool,
  admin: SupabaseClient,
  config: Config,
  organizationId: string = DEFAULT_ORGANIZATION_ID
): Promise<void> {
  const existing = await db.query(`SELECT id FROM app_users WHERE organization_id = $1 LIMIT 1`, [organizationId]);
  if (existing.rows.length > 0) return;

  if (!config.bootstrapAdminEmail || !config.bootstrapAdminPassword) {
    throw new Error(
      "No admin user exists yet and BOOTSTRAP_ADMIN_EMAIL/BOOTSTRAP_ADMIN_PASSWORD are not set. " +
        "Set both env vars and restart to create the first admin account."
    );
  }

  const { error } = await admin.auth.admin.createUser({
    email: config.bootstrapAdminEmail,
    password: config.bootstrapAdminPassword,
    email_confirm: true,
    app_metadata: { organization_id: organizationId, role: "admin", name: "Admin" },
  });
  if (error) throw error;
}
