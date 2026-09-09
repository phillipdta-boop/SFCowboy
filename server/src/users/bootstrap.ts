import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Config } from "../config.js";
import { withTransaction } from "../db/client.js";
import { hashPassword } from "./users.js";

const BACKFILL_TABLES = ["connections", "pipelines", "deployments", "deployment_items", "pipeline_runs"] as const;

/**
 * Runs once per environment, the first time the app boots against a database with no
 * organizations yet: creates one Organization for the existing (pre-multi-tenancy) data, creates
 * one Admin user from the two bootstrap env vars, and backfills organization_id on every existing
 * row so the app's data isn't orphaned once org-scoping is enforced (see the follow-up plan).
 * Idempotent — a no-op on every later boot once `organizations` is non-empty, called from
 * index.ts right after runMigrations the same way every other one-time schema concern in this
 * codebase is handled.
 *
 * The idempotency check runs outside any transaction (nothing to make atomic there — it's a
 * single read), but the org insert, admin-user insert, and all 5 backfill updates are wrapped in
 * one transaction: without it, a crash or dropped connection between the org insert and the user
 * insert would leave an organization row with no admin user at all, and the idempotency check
 * above (organizations non-empty) would then make every later boot silently skip re-running the
 * rest forever — an unrecoverable state with no self-serve signup to fall back on. The password is
 * hashed before the transaction opens since bcrypt is CPU-bound and unrelated to the DB work, so
 * there's no reason to hold a transaction (and its connection) open across it.
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
  const userId = randomUUID();
  const passwordHash = await hashPassword(config.bootstrapAdminPassword);
  const email = config.bootstrapAdminEmail.toLowerCase();
  const now = new Date().toISOString();

  await withTransaction(db, async (client) => {
    await client.query(`INSERT INTO organizations (id, name, created_at) VALUES ($1, $2, $3)`, [orgId, config.bootstrapOrgName, now]);

    // Inlined rather than calling createUser(db, ...) (which is typed to accept a Pool, not this
    // transaction's PoolClient) — same query createUser itself runs. Matches the precedent set by
    // invites.ts's acceptInvite for calling into a shared transaction.
    await client.query(
      `INSERT INTO users (id, organization_id, email, password_hash, role, name, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, orgId, email, passwordHash, "admin", "Admin", now]
    );

    for (const table of BACKFILL_TABLES) {
      await client.query(`UPDATE ${table} SET organization_id = $1 WHERE organization_id IS NULL`, [orgId]);
    }
  });
}
