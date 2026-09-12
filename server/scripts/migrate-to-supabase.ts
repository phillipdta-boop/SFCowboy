import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

// Order matters: deployments/deployment_items reference connections and pipeline_runs via
// foreign keys, and pipeline_runs references pipelines -- copying in dependency order avoids a
// foreign-key violation on the target (which starts empty, unlike the source).
const TABLES_IN_DEPENDENCY_ORDER = ["connections", "pipelines", "pipeline_runs", "deployments", "deployment_items"] as const;

export interface MigrationTableSummary {
  table: string;
  rowCount: number;
}

/**
 * Copies every row from `sourcePool` into `targetPool`, table by table, setting organization_id
 * to the given value on every row as it's inserted (overriding whatever the source table's
 * DEFAULT would have produced, since the source is main's pre-Supabase schema which may not even
 * have this column at all yet). Both pools must already have the target schema applied
 * (organizations row for organizationId must already exist -- run `npm run build && node
 * dist/index.js` once against the target first, or apply schema.sql directly, before running
 * this).
 *
 * Runs the whole copy inside a single transaction on one checked-out client -- this is a one-shot,
 * no-undo production data move, and without a transaction a failure partway through the
 * dependency-ordered table loop left the target half-populated, with no clean way to retry (the
 * INSERTs don't use ON CONFLICT, so simply re-running threw a duplicate-key error on every row
 * that had already landed). On any failure, every row this call inserted is rolled back, so the
 * target is left exactly as it was before this ran and can simply be retried.
 */
export async function migrateToSupabase(sourcePool: Pool, targetPool: Pool, organizationId: string): Promise<MigrationTableSummary[]> {
  const summary: MigrationTableSummary[] = [];
  const client = await targetPool.connect();

  try {
    await client.query("BEGIN");

    for (const table of TABLES_IN_DEPENDENCY_ORDER) {
      const { rows } = await sourcePool.query(`SELECT * FROM ${table}`);
      for (const row of rows) {
        const columns = Object.keys(row).filter((c) => c !== "organization_id");
        const values = columns.map((c) => row[c]);
        const placeholders = columns.map((_, i) => `$${i + 1}`);
        await client.query(
          `INSERT INTO ${table} (${columns.join(", ")}, organization_id) VALUES (${placeholders.join(", ")}, $${columns.length + 1})`,
          [...values, organizationId]
        );
      }
      summary.push({ table, rowCount: rows.length });
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return summary;
}

// Only run the CLI entrypoint when this file is executed directly (`tsx scripts/migrate-...`),
// not when migrateToSupabase is imported by the test above. Compared as resolved filesystem
// paths (not raw URL/argv strings) so this works cross-platform: on Windows, process.argv[1] uses
// backslashes while import.meta.url is a `file://` URL with forward slashes, so a direct string
// comparison never matches there and the CLI would silently no-op. (Identical guard to
// scripts/migrate-sqlite-to-postgres.ts's own -- copied verbatim, not reinvented.)
const isMainModule = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMainModule) {
  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  const targetUrl = process.env.DATABASE_URL;
  const organizationId = process.env.MIGRATION_ORGANIZATION_ID;
  if (!sourceUrl || !targetUrl || !organizationId) {
    console.error("Usage: SOURCE_DATABASE_URL=... DATABASE_URL=<supabase> MIGRATION_ORGANIZATION_ID=... tsx scripts/migrate-to-supabase.ts");
    process.exit(1);
  }
  const sourcePool = new Pool({ connectionString: sourceUrl });
  const targetPool = new Pool({ connectionString: targetUrl });
  const summary = await migrateToSupabase(sourcePool, targetPool, organizationId);
  console.table(summary);
  await sourcePool.end();
  await targetPool.end();
}
