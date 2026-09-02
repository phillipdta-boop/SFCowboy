import { Pool, type PoolClient } from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function openDb(connectionString: string): Pool {
  return new Pool({ connectionString });
}

/**
 * Runs `fn` inside a single Postgres transaction on a dedicated client, committing on success and
 * rolling back on any thrown error. Used wherever a multi-statement write needs atomicity — today,
 * only the deployments-table constraint fixes below, which is why this lives in this file rather
 * than a shared db-utils module; promote it if a second caller ever needs it.
 */
export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function runMigrations(db: Pool): Promise<void> {
  const schemaPath = path.join(__dirname, "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf-8");
  await db.query(schema);

  // schema.sql's CREATE TABLE IF NOT EXISTS won't alter a table that already exists from an
  // older schema version — these are idempotent no-ops on a fresh database (CREATE TABLE above
  // already includes every column) and only do real work when upgrading an existing database
  // created from an older version of this file. Kept anyway: this IS the mechanism future schema
  // changes use (e.g. the org-scoping columns the next phase adds).
  await db.query(`ALTER TABLE connections ADD COLUMN IF NOT EXISTS encrypted_client_id TEXT`);
  await db.query(`ALTER TABLE connections ADD COLUMN IF NOT EXISTS last_error TEXT`);
  await db.query(`ALTER TABLE connections ADD COLUMN IF NOT EXISTS login_username TEXT`);
  await db.query(`ALTER TABLE connections ADD COLUMN IF NOT EXISTS min_code_coverage_percent INTEGER`);

  await db.query(
    `ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed'))`
  );
  await db.query(`ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS track_components_independently INTEGER NOT NULL DEFAULT 1`);

  await db.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS title TEXT`);
  for (const column of ["ignore_warnings", "allow_missing_files", "auto_update_package"]) {
    await db.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS ${column} INTEGER NOT NULL DEFAULT 0`);
  }
  await db.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS run_tests TEXT NOT NULL DEFAULT '[]'`);
  await db.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS sf_job_id TEXT`);
  for (const column of ["components_deployed", "components_total", "tests_completed", "tests_total"]) {
    await db.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS ${column} INTEGER`);
  }
  await db.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS run_by TEXT`);
  await db.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS pipeline_run_id TEXT REFERENCES pipeline_runs(id)`);
  await db.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS pipeline_step_index INTEGER`);
  await db.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS coverage_percent REAL`);
  await db.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS coverage_details TEXT`);
  for (const column of ["source_branch", "target_branch", "static_analysis_findings", "scheduled_at", "package_path"]) {
    await db.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS ${column} TEXT`);
  }

  // Postgres can ALTER a CHECK/NOT NULL constraint directly — no SQLite-style rebuild needed.
  // These are no-ops on a fresh database (schema.sql's CREATE TABLE already has both fixes) and
  // only matter for a database created from an older version of this file.
  const statusCheck = await db.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
     WHERE conrelid = 'deployments'::regclass AND contype = 'c' AND conname = 'deployments_status_check'`
  );
  if (statusCheck.rows[0] && !statusCheck.rows[0].definition.includes("cancelled")) {
    await withTransaction(db, async (client) => {
      await client.query(`ALTER TABLE deployments DROP CONSTRAINT deployments_status_check`);
      await client.query(
        `ALTER TABLE deployments ADD CONSTRAINT deployments_status_check
         CHECK (status IN ('pending','validating','deploying','succeeded','failed','rolled_back','cancelled'))`
      );
    });
  }

  const sourceConnectionIdNullable = await db.query<{ is_nullable: string }>(
    `SELECT is_nullable FROM information_schema.columns
     WHERE table_name = 'deployments' AND column_name = 'source_connection_id'
       AND table_schema = current_schema()`
  );
  if (sourceConnectionIdNullable.rows[0]?.is_nullable === "NO") {
    await db.query(`ALTER TABLE deployments ALTER COLUMN source_connection_id DROP NOT NULL`);
  }
}
