import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Config } from "../config.js";
import { hashPassword, createUser } from "./users.js";

const BACKFILL_TABLES = ["connections", "pipelines", "deployments", "deployment_items", "pipeline_runs"] as const;

/**
 * Runs once per environment, the first time the app boots against a database with no
 * organizations yet: creates one Organization for the existing (pre-multi-tenancy) data, creates
 * one Admin user from the two bootstrap env vars, and backfills organization_id on every existing
 * row so the app's data isn't orphaned once org-scoping is enforced (see the follow-up plan).
 * Idempotent — a no-op on every later boot once `organizations` is non-empty, called from
 * index.ts right after runMigrations the same way every other one-time schema concern in this
 * codebase is handled.
 */
export async function bootstrapIfNeeded(db: Pool, config: Config): Promise<void> {
  const existing = await db.query(`SELECT id FROM organizations LIMIT 1`);
  if (existing.rows.length > 0) return;

  if (!config.bootstrapAdminEmail || !config.bootstrapAdminPassword) {
    throw new Error(
      "No organization exists yet and BOOTSTRAP_ADMIN_EMAIL/BOOTSTRAP_ADMIN_PASSWORD are not set. " +
        "Set both env vars and restart to create the first organization and admin account."
    );
  }

  const orgId = randomUUID();
  await db.query(`INSERT INTO organizations (id, name, created_at) VALUES ($1, $2, $3)`, [orgId, config.bootstrapOrgName, new Date().toISOString()]);

  await createUser(db, {
    organizationId: orgId,
    email: config.bootstrapAdminEmail,
    passwordHash: await hashPassword(config.bootstrapAdminPassword),
    role: "admin",
    name: "Admin",
  });

  for (const table of BACKFILL_TABLES) {
    await db.query(`UPDATE ${table} SET organization_id = $1 WHERE organization_id IS NULL`, [orgId]);
  }
}
