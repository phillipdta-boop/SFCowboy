import Database from "better-sqlite3";
import type { Pool } from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { openDb, runMigrations, withTransaction } from "../src/db/client.js";

// Dependency order matters: deployments references connections and pipeline_runs;
// deployment_items references deployments; pipeline_runs references pipelines.
const TABLES_IN_DEPENDENCY_ORDER = ["connections", "pipelines", "pipeline_runs", "deployments", "deployment_items"] as const;

/**
 * One-time cutover script: copies every row from an existing SQLite database into a Postgres
 * database that already has the current schema applied (via runMigrations), in dependency order
 * so foreign keys never point at a row that hasn't been inserted yet. Read-only against the
 * SQLite file — never writes to it. Returns the row count copied per table, for the operator to
 * verify against a `SELECT COUNT(*)` on the original file before proceeding with the cutover.
 *
 * The entire copy (all tables) runs inside a single Postgres transaction: if the script fails
 * partway through, nothing is left committed, so a re-run starts from a clean slate instead of
 * hitting primary-key violations on rows that were already inserted.
 */
export async function migrateSqliteToPostgres(sqliteFilePath: string, pgPool: Pool): Promise<Record<string, number>> {
  const sqlite = new Database(sqliteFilePath, { readonly: true });
  const counts: Record<string, number> = {};

  try {
    await withTransaction(pgPool, async (client) => {
      for (const table of TABLES_IN_DEPENDENCY_ORDER) {
        const rows = sqlite.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
        counts[table] = rows.length;
        for (const row of rows) {
          const columns = Object.keys(row);
          const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
          const values = columns.map((c) => row[c]);
          await client.query(
            `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`,
            values
          );
        }
      }
    });
  } finally {
    sqlite.close();
  }

  return counts;
}

async function main() {
  const sqliteFilePath = process.argv[2];
  if (!sqliteFilePath) {
    console.error("Usage: tsx scripts/migrate-sqlite-to-postgres.ts <path-to-sqlite-file>");
    process.exit(1);
  }

  const config = loadConfig();
  const pool = openDb(config.databaseUrl);
  await runMigrations(pool);

  console.log(`Migrating ${sqliteFilePath} -> ${config.databaseUrl} ...`);
  const counts = await migrateSqliteToPostgres(sqliteFilePath, pool);
  console.log("Rows copied per table:");
  for (const [table, count] of Object.entries(counts)) {
    console.log(`  ${table}: ${count}`);
  }

  await pool.end();
}

// Only run the CLI entrypoint when this file is executed directly (`tsx scripts/migrate-...`),
// not when migrateSqliteToPostgres is imported by the test above. Compared as resolved filesystem
// paths (not raw URL/argv strings) so this works cross-platform: on Windows, process.argv[1] uses
// backslashes while import.meta.url is a `file://` URL with forward slashes, so a direct string
// comparison never matches there and the CLI would silently no-op.
const isMainModule = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMainModule) {
  main().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
