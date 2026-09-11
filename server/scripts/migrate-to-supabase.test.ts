import { describe, it, expect, afterEach } from "vitest";
import { openTestDb, type TestDb } from "../src/db/testDb.js";
import { migrateToSupabase } from "./migrate-to-supabase.js";

describe("migrateToSupabase", () => {
  let source: TestDb;
  let target: TestDb;

  afterEach(async () => {
    await source?.stop();
    await target?.stop();
  });

  it("copies every row from source to target, assigning the given organization_id", async () => {
    source = await openTestDb();
    target = await openTestDb();
    const orgId = "11111111-1111-1111-1111-111111111111";
    // ON CONFLICT DO NOTHING: organizations is a shared, project-wide table (not isolated per
    // test schema -- see testDb.ts's opening comment), so this literal id may already exist from
    // a previous run of this same test file (the other `it` block below inserts it too).
    await target.pool.query(
      `INSERT INTO organizations (id, name, created_at) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [orgId, "Migrated Org", new Date().toISOString()]
    );

    await source.pool.query(
      `INSERT INTO connections (id, type, nickname, created_at) VALUES ('c1', 'git', 'Source Connection', '2026-01-01T00:00:00.000Z')`
    );
    await source.pool.query(
      `INSERT INTO pipelines (id, name, connection_ids, status) VALUES ('p1', 'Source Pipeline', '["c1"]', 'active')`
    );

    const summary = await migrateToSupabase(source.pool, target.pool, orgId);

    const connectionsCopied = summary.find((s) => s.table === "connections");
    expect(connectionsCopied?.rowCount).toBe(1);

    const targetConnection = await target.pool.query(`SELECT nickname, organization_id FROM connections WHERE id = 'c1'`);
    expect(targetConnection.rows[0]).toEqual({ nickname: "Source Connection", organization_id: orgId });

    const targetPipeline = await target.pool.query(`SELECT name, organization_id FROM pipelines WHERE id = 'p1'`);
    expect(targetPipeline.rows[0].organization_id).toBe(orgId);
  });

  it("is safe to run when a table has zero rows", async () => {
    source = await openTestDb();
    target = await openTestDb();
    const orgId = "11111111-1111-1111-1111-111111111111";
    await target.pool.query(
      `INSERT INTO organizations (id, name, created_at) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [orgId, "Migrated Org", new Date().toISOString()]
    );

    const summary = await migrateToSupabase(source.pool, target.pool, orgId);
    expect(summary.every((s) => s.rowCount === 0)).toBe(true);
  });
});
