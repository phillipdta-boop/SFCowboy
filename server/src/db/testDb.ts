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
  // Short-lived (created, used for one CREATE SCHEMA, then ended a few lines below) but still
  // capable of emitting 'error' on an idle client in that brief window — same unguarded-crash
  // risk as the long-lived pool below, just a smaller blast radius. Cheap to guard too.
  adminPool.on("error", (err) => console.error("Idle Postgres client error (test admin pool)", err));
  await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
  await adminPool.end();

  const pool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });
  // This pool lives for the whole test's duration — the same unguarded-'error' crash risk as
  // openDb's production pool applies here too (see client.ts's openDb for the full explanation).
  pool.on("error", (err) => console.error("Idle Postgres client error (test pool)", err));
  await runMigrations(pool);

  return {
    pool,
    stop: async () => {
      await pool.end();
      const cleanupPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING });
      cleanupPool.on("error", (err) => console.error("Idle Postgres client error (test cleanup pool)", err));
      await cleanupPool.query(`DROP SCHEMA "${schemaName}" CASCADE`);
      await cleanupPool.end();
    },
  };
}
