import { describe, it, expect, afterEach } from "vitest";
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
