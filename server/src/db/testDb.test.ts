import { describe, it, expect, afterEach } from "vitest";
import { openTestDb } from "./testDb.js";

describe("openTestDb", () => {
  let stop: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (stop) await stop();
    stop = undefined;
  });

  it("returns a working Postgres pool, isolated in its own schema, with the current schema already applied", async () => {
    const db = await openTestDb();
    stop = db.stop;

    const result = await db.pool.query("SELECT 1 + 1 AS sum");
    expect(result.rows[0].sum).toBe(2);

    const tables = await db.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name`
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual(
      expect.arrayContaining(["connections", "pipelines", "pipeline_runs", "deployments", "deployment_items"])
    );
  }, 30_000);

  it("isolates two concurrently-open test databases from each other", async () => {
    const dbA = await openTestDb();
    const dbB = await openTestDb();
    try {
      await dbA.pool.query(`INSERT INTO connections (id, type, nickname, created_at) VALUES ('only-in-a', 'org', 'A', now()::text)`);
      const inB = await dbB.pool.query(`SELECT id FROM connections WHERE id = 'only-in-a'`);
      expect(inB.rows).toHaveLength(0);
    } finally {
      await dbA.stop();
      await dbB.stop();
    }
  }, 30_000);
});
