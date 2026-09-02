import { Pool } from "pg";
import { randomBytes } from "node:crypto";
import { runMigrations } from "./client.js";

export interface TestDb {
  pool: Pool;
  stop: () => Promise<void>;
}

// Points at a real, already-running Postgres server rather than spinning one up per test run —
// this project's dev/CI environment has no Docker available, so there is no testcontainers-style
// ephemeral-container option here. Defaults to the local, no-admin-rights install this
// implementation set up: `initdb` + `pg_ctl start` on port 5433, user `sfcowboy`, trust auth.
// Override with TEST_DATABASE_URL to point at a different reachable Postgres server (e.g. in CI).
const ADMIN_CONNECTION_STRING = process.env.TEST_DATABASE_URL ?? "postgres://sfcowboy@localhost:5433/sfcowboy";

/**
 * Isolates a single test file/run inside its own freshly created schema on the shared server
 * above, with the current schema already applied, then drops that schema on stop(). This is the
 * schema-per-run equivalent of what `openDb(":memory:")` + `runMigrations(db)` gave for free under
 * SQLite (a throwaway, isolated database per run) — a container-per-run isn't available here, but
 * two concurrently open openTestDb() calls still never see each other's data.
 */
export async function openTestDb(): Promise<TestDb> {
  const schemaName = `test_${randomBytes(8).toString("hex")}`;
  const adminPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING });
  await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
  await adminPool.end();

  const pool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });
  await runMigrations(pool);

  return {
    pool,
    stop: async () => {
      await pool.end();
      const cleanupPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING });
      await cleanupPool.query(`DROP SCHEMA "${schemaName}" CASCADE`);
      await cleanupPool.end();
    },
  };
}
