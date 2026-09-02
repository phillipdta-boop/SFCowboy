import { describe, it, expect, afterEach } from "vitest";
import { Pool } from "pg";
import { openTestDb, type TestDb } from "./testDb.js";
import { runMigrations, withTransaction } from "./client.js";

describe("runMigrations", () => {
  let db: TestDb | undefined;

  afterEach(async () => {
    if (db) await db.stop();
    db = undefined;
  });

  it("is idempotent — running it twice on the same database does not error", async () => {
    db = await openTestDb();
    await expect(runMigrations(db.pool)).resolves.not.toThrow();
  }, 60_000);

  it("creates the deployments table with 'cancelled' already in the status CHECK constraint", async () => {
    db = await openTestDb();
    await expect(
      db.pool.query(
        `INSERT INTO deployments (id, target_connection_id, component_list, test_level, status, started_at)
         VALUES ('d1', 't', '[]', 'NoTestRun', 'cancelled', now()::text)`
      )
    ).resolves.not.toThrow();
  }, 60_000);

  it("allows source_connection_id to be NULL (an imported deployment has no source)", async () => {
    db = await openTestDb();
    await expect(
      db.pool.query(
        `INSERT INTO deployments (id, target_connection_id, component_list, test_level, status, started_at)
         VALUES ('d1', 't', '[]', 'NoTestRun', 'pending', now()::text)`
      )
    ).resolves.not.toThrow();
  }, 60_000);

  it("enforces the deployments.status CHECK constraint against an invalid value", async () => {
    db = await openTestDb();
    await expect(
      db.pool.query(
        `INSERT INTO deployments (id, target_connection_id, component_list, test_level, status, started_at)
         VALUES ('d1', 't', '[]', 'NoTestRun', 'not-a-real-status', now()::text)`
      )
    ).rejects.toThrow();
  }, 60_000);

  it("enforces the deployment_items.deployment_id foreign key against deployments", async () => {
    db = await openTestDb();
    await expect(
      db.pool.query(
        `INSERT INTO deployment_items (id, deployment_id, metadata_type, api_name, action, status)
         VALUES ('item1', 'no-such-deployment', 'ApexClass', 'A', 'add', 'pending')`
      )
    ).rejects.toThrow();
  }, 60_000);

  it("upgrades an existing database whose deployments_status_check predates 'cancelled'", async () => {
    db = await openTestDb();

    // Simulate a database migrated from an older schema version where the CHECK constraint
    // did not yet include 'cancelled'.
    await db.pool.query(`ALTER TABLE deployments DROP CONSTRAINT deployments_status_check`);
    await db.pool.query(
      `ALTER TABLE deployments ADD CONSTRAINT deployments_status_check
       CHECK (status IN ('pending','validating','deploying','succeeded','failed','rolled_back'))`
    );

    // Confirm the stale constraint really does reject 'cancelled' before the guard runs again.
    await expect(
      db.pool.query(
        `INSERT INTO deployments (id, target_connection_id, component_list, test_level, status, started_at)
         VALUES ('stale1', 't', '[]', 'NoTestRun', 'cancelled', now()::text)`
      )
    ).rejects.toThrow();

    await runMigrations(db.pool);

    await expect(
      db.pool.query(
        `INSERT INTO deployments (id, target_connection_id, component_list, test_level, status, started_at)
         VALUES ('stale1', 't', '[]', 'NoTestRun', 'cancelled', now()::text)`
      )
    ).resolves.not.toThrow();
  }, 60_000);

  it("upgrades an existing database whose source_connection_id is still NOT NULL", async () => {
    db = await openTestDb();

    // Simulate a database migrated from an older schema version where source_connection_id
    // was still required.
    await db.pool.query(`ALTER TABLE deployments ALTER COLUMN source_connection_id SET NOT NULL`);

    // Confirm the stale NOT NULL really does reject a NULL source_connection_id before the guard
    // runs again.
    await expect(
      db.pool.query(
        `INSERT INTO deployments (id, target_connection_id, component_list, test_level, status, started_at)
         VALUES ('stale2', 't', '[]', 'NoTestRun', 'pending', now()::text)`
      )
    ).rejects.toThrow();

    await runMigrations(db.pool);

    await expect(
      db.pool.query(
        `INSERT INTO deployments (id, target_connection_id, component_list, test_level, status, started_at)
         VALUES ('stale2', 't', '[]', 'NoTestRun', 'pending', now()::text)`
      )
    ).resolves.not.toThrow();
  }, 60_000);
});

describe("withTransaction", () => {
  let db: TestDb | undefined;

  afterEach(async () => {
    if (db) await db.stop();
    db = undefined;
  });

  it("commits all writes when the callback succeeds", async () => {
    db = await openTestDb();
    await withTransaction(db.pool, async (client) => {
      await client.query(
        `INSERT INTO connections (id, type, nickname, created_at) VALUES ('c1', 'org', 'Dev', now()::text)`
      );
    });
    const result = await db.pool.query(`SELECT id FROM connections WHERE id = 'c1'`);
    expect(result.rows).toHaveLength(1);
  }, 60_000);

  it("rolls back all writes when the callback throws", async () => {
    db = await openTestDb();
    await expect(
      withTransaction(db.pool, async (client) => {
        await client.query(
          `INSERT INTO connections (id, type, nickname, created_at) VALUES ('c1', 'org', 'Dev', now()::text)`
        );
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    const result = await db.pool.query(`SELECT id FROM connections WHERE id = 'c1'`);
    expect(result.rows).toHaveLength(0);
  }, 60_000);
});

describe("pool 'error' handling", () => {
  let db: TestDb | undefined;

  afterEach(async () => {
    if (db) await db.stop();
    db = undefined;
  });

  // Reproduces the exact failure the final-review reviewer found: a client sitting idle in the
  // pool gets its backend connection killed server-side (a Postgres restart, an admin
  // pg_terminate_backend, an idle-connection reaper, an LB/NAT reset). pg.Pool re-emits that as
  // an 'error' event; with no listener, Node throws it as an uncaught exception and kills the
  // whole process. openTestDb's pool now installs a listener (see testDb.ts) — this test proves
  // that guard actually works, by terminating a real backend connection from a second connection
  // and confirming the pool survives and serves its next query normally instead of crashing.
  it("survives a backend connection terminated server-side and keeps serving queries", async () => {
    db = await openTestDb();

    // Tag this specific connection's application_name so the killer below can target exactly this
    // one idle client — never anything belonging to another test file's pool that happens to be
    // idle against the same shared Postgres server at the same time (vitest can run test files
    // concurrently, and this whole project points every test at one shared server/database,
    // isolated only by per-run schema — see testDb.ts). SET is session-scoped and node-postgres
    // doesn't reset session state between queries on a reused client, so this sticks for the life
    // of this one connection.
    const tag = `pool_error_test_${Math.random().toString(36).slice(2)}`;
    await db.pool.query(`SET application_name = '${tag}'`);

    // Resolves once the pool's own 'error' listener (installed in testDb.ts) has actually run —
    // i.e. once the doomed client has really been discarded — so the query below can't race the
    // teardown and get handed the same about-to-die client.
    const poolHandledTheError = new Promise<void>((resolve) => db!.pool.once("error", () => resolve()));

    const killer = new Pool({ connectionString: process.env.TEST_DATABASE_URL ?? "postgres://sfcowboy@localhost:5433/sfcowboy" });
    killer.on("error", (err) => console.error("Idle Postgres client error (test killer pool)", err));
    try {
      const pids = await killer.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND state = 'idle'`,
        [tag]
      );
      expect(pids.rows.length).toBeGreaterThan(0);
      for (const row of pids.rows) {
        await killer.query(`SELECT pg_terminate_backend($1)`, [row.pid]);
      }
    } finally {
      await killer.end();
    }

    // If the pool's 'error' listener weren't installed, this rejection would already have thrown
    // as an uncaught exception and crashed the test process by now instead of resolving here.
    await Promise.race([poolHandledTheError, new Promise((resolve) => setTimeout(resolve, 5000))]);

    // The pool should have discarded the dead client and transparently opened a fresh one to
    // serve this query, rather than the process having crashed or this query failing.
    const result = await db.pool.query(`SELECT 1 AS ok`);
    expect(result.rows[0].ok).toBe(1);
  }, 60_000);
});
